// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock as the shell draws it. A tab press follows the gesture law; each
// open panel draws the screen of the view it is on, and its door carries that
// view's own address, or its board's when the view has none (CS-3.3). A link
// followed inside a panel walks the panel, not the page.

import type { MouseEvent } from 'react';
import type { DockPanel, DockProps, ShellProps } from '@launchastro/ui';
import { gateOf, matchRoute, pathTo, type Gate } from '../routes.ts';
import { PANELS, dockTabs, isPanelId, type PanelId, type PanelRegistry } from '../panels.ts';
import { drawScreen, type ScreenContext } from '../screen-registry.tsx';
import { closeAll, close, isOwnAddress, press, ranked, visit } from './open-set.ts';
import type { Session, StorageLike } from '../session/token.ts';
import type { OperationsClient } from '../operations/client.ts';
import { useLayoutStore } from '../shell/layout-store.ts';
import { railFrom, useRail, type RailModel } from '../shell/use-rail.ts';
import { useDock, type DockModel } from './use-dock.ts';
import { useDockLayout, type DockLayoutModel } from './use-layout.ts';
import { taskPanelOf, useTaskDock, withTaskTab, type TaskDock } from './task-dock.ts';

/** The person's dock, rail and the layout they make together, for one signed-in tab. */
interface DockShell {
  readonly registry: PanelRegistry;
  readonly dock: DockModel;
  readonly nav: RailModel;
  readonly layout: DockLayoutModel;
  /** The task panel (MP-4-8), drawn as the dock's `task` panel; null where there is none. */
  readonly task: TaskDock | null;
}

/** What the application takes for the dock and the rail. */
export interface DockAppProps {
  /** The dock's panels. The shipped registry unless a test hands another. */
  readonly panels?: PanelRegistry;
}

/** The person's rail and dock sizes come from MP-2-11's one preference store, through `client`. */
export function useDockShell(
  client: OperationsClient,
  session: Session | null,
  storage: StorageLike | null,
  props: DockAppProps,
  task: TaskDock | null = null,
): DockShell {
  const registry = props.panels ?? PANELS;
  const dock = useDock(session, storage, registry);
  const store = useLayoutStore(client, session, storage);
  const { layout: kept } = store;
  const nav = useRail(
    railFrom({ collapsed: kept['rail.collapsed'], width: kept['rail.width'] }),
    store.save,
  );
  const layout = useDockLayout(dock, registry, nav.drawn, store);
  useTaskDock(dock, task);
  return { registry, dock, nav, layout, task };
}

type ShellDock = Pick<
  ShellProps,
  | 'onClick'
  | 'dock'
  | 'railCollapsed'
  | 'railWidth'
  | 'onRailFold'
  | 'onRailResize'
  | 'onRailResizeEnd'
  | 'dockWidth'
  | 'dockSheetHeight'
>;

/**
 * What the shell takes of the dock and the rail: the doors' click, the rail as
 * the person left it, the seated group's width, the sheet, and the dock itself,
 * or none where `input` is null (signed out, and the client face, R17).
 */
export const shellDock = (
  { registry, dock, nav, layout, task }: DockShell,
  screen: DockInput['screen'] | null,
): ShellDock => ({
  onClick: dock.onDoor,
  dock: screen === null ? null : dockProps({ registry, dock, layout, screen, task }),
  railCollapsed: nav.collapsed,
  railWidth: nav.width,
  onRailFold: nav.fold,
  onRailResize: nav.resize,
  onRailResizeEnd: nav.keep,
  dockWidth: layout.geometry.mode === 'seated' ? layout.geometry.groupWidth : 0,
  dockSheetHeight: layout.sheetHeight,
});

interface DockInput {
  readonly registry: PanelRegistry;
  readonly dock: DockModel;
  readonly layout: DockLayoutModel;
  readonly screen: Omit<ScreenContext, 'params'>;
  readonly task: TaskDock | null;
}

export function dockProps(input: DockInput): DockProps {
  const { registry, dock, layout } = input;
  const tabs = withTaskTab(
    dockTabs({}, registry).map((tab) => ({
      id: tab.id,
      label: tab.label,
      icon: tab.icon,
      count: tab.count,
      open: dock.state.open.includes(tab.id),
    })),
    input.task,
    dock.state.open.includes('task'),
  );
  // An id from a press is one of the tabs drawn, or nothing.
  const byId = (id: string): PanelId | null =>
    isPanelId(id) && tabs.some((tab) => tab.id === id) ? id : null;
  return {
    tabs,
    layout: {
      mode: layout.geometry.mode,
      panelWidth: layout.geometry.panelWidth,
      sheetHeight: layout.sheetHeight,
      sheetMax: layout.sheetMax,
    },
    onSheetResize: layout.setSheetHeight,
    onSheetResizeEnd: layout.keepSheetHeight,
    stamp: layout.stamp,
    onResize: layout.setWidth,
    onResizeEnd: layout.keepWidth,
    panels: dockPanels(input),
    ...dockPresses(input, byId),
  };
}

function dockPanels(input: DockInput): readonly DockPanel[] {
  const { registry, dock, layout } = input;
  // On a phone one panel draws: the one opened last.
  const last = dock.state.open.at(-1);
  const drawn = new Set(
    layout.geometry.mode === 'phone' ? (last === undefined ? [] : [last]) : layout.geometry.open,
  );
  return ranked(dock.state).flatMap((id) => {
    const panel = registry[id];
    // A panel R39 is closing draws nothing while the close lands.
    if (!drawn.has(id)) return [];
    const walked = {
      canBack: dock.history.canBack,
      canForward: dock.history.canForward,
      scrollTop: dock.history.restored.scroll[id],
    };
    if (id === 'task') return input.task === null ? [] : [taskPanelOf(input.task, walked)];
    if (panel === undefined) return [];
    const place = dock.state.places[id];
    const door = screenAt(place) === null ? pathTo(panel.route) : (place ?? pathTo(panel.route));
    const view = screenAt(door);
    return [
      {
        id,
        label: panel.label,
        ariaLabel: panel.ariaLabel,
        door,
        icon: panel.icon,
        ...walked,
        body:
          view === null
            ? null
            : drawScreen(view.match, { ...input.screen, address: door, inPanel: true }),
      },
    ];
  });
}

type Presses = Omit<DockProps, 'tabs' | 'panels' | 'layout'>;

function dockPresses(input: DockInput, byId: (id: string) => PanelId | null): Presses {
  const { dock } = input;
  return {
    onTab: (id, shift) => {
      const panel = byId(id);
      if (panel !== null) dock.change((state) => press(state, panel, shift));
    },
    onClose: (id) => {
      const panel = byId(id);
      if (panel !== null) dock.change((state) => close(state, panel));
    },
    onCloseAll: () => {
      dock.change(closeAll);
    },
    onBack: dock.history.back,
    onForward: dock.history.forward,
    restoreWalk: dock.history.restored.walk,
    onScroll: (id, top) => {
      const panel = byId(id);
      if (panel !== null) dock.history.seal(panel, top);
    },
    onDoor: input.screen.navigate,
    onBodyClick: (id, event) => {
      const panel = byId(id);
      // The task panel's links are its own: its page, its page link, its doors.
      const href = panel === null || panel === 'task' ? null : walkedLink(event);
      if (panel === null || href === null) return;
      event.preventDefault();
      dock.change((state) => visit(state, panel, href));
    },
  };
}

/** The address a plain click on a link inside a panel walks the panel to, or null to leave it. */
function walkedLink(event: MouseEvent<HTMLDivElement>): string | null {
  // A link that is itself a door into the dock is the gesture law's, not a walk.
  const link =
    event.target instanceof Element
      ? event.target.closest('a[href]:not([data-dock-open]):not([data-ask])')
      : null;
  if (link === null || event.defaultPrevented) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  if (link.getAttribute('target') !== null && link.getAttribute('target') !== '_self') return null;
  const href = link.getAttribute('href') ?? '';
  return screenAt(href) === null ? null : href;
}

/** The screen an address this application owns draws, or null for none. */
function screenAt(address: string | undefined): Extract<Gate, { readonly kind: 'screen' }> | null {
  if (!isOwnAddress(address)) return null;
  try {
    const gate = gateOf(matchRoute(address.split(/[?#]/u)[0] ?? address), true);
    return gate.kind === 'screen' ? gate : null;
  } catch {
    // A malformed escape in the address: it names no view.
    return null;
  }
}
