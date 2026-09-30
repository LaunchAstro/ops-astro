// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock as the shell draws it. A tab press follows the gesture law; each
// open panel draws the screen of the view it is on, and its door carries that
// view's own address, or its board's when the view has none (CS-3.3). A link
// followed inside a panel walks the panel, not the page.

import type { MouseEvent } from 'react';
import type { DockPanel, DockProps } from '@launchastro/ui';
import { gateOf, matchRoute, pathTo, type Gate } from '../routes.ts';
import { dockTabs, isPanelId, type PanelId, type PanelRegistry } from '../panels.ts';
import { drawScreen, type ScreenContext } from '../screen-registry.tsx';
import { closeAll, close, isOwnAddress, press, ranked, visit } from './open-set.ts';
import type { useDock } from './use-dock.ts';
import type { useDockLayout } from './use-layout.ts';

interface DockInput {
  readonly registry: PanelRegistry;
  readonly dock: ReturnType<typeof useDock>;
  readonly layout: ReturnType<typeof useDockLayout>;
  readonly navigate: (path: string) => void;
  readonly screen: Omit<ScreenContext, 'params'>;
}

export function dockProps(input: DockInput): DockProps {
  const { registry, dock, layout } = input;
  const tabs = dockTabs({}, registry);
  // An id from a press is one of the tabs drawn, or nothing.
  const byId = (id: string): PanelId | null =>
    isPanelId(id) && tabs.some((tab) => tab.id === id) ? id : null;
  return {
    tabs: tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      icon: tab.icon,
      count: tab.count,
      open: dock.state.open.includes(tab.id),
    })),
    layout: {
      mode: layout.geometry.mode,
      panelWidth: layout.geometry.panelWidth,
      sheetHeight: layout.sheetHeight,
      sheetMax: layout.sheetMax,
    },
    onSheetResize: layout.setSheetHeight,
    stamp: layout.stamp,
    onResize: layout.setWidth,
    onResizeEnd: layout.setWidth,
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
    if (panel === undefined || !drawn.has(id)) return [];
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
        canBack: dock.history.canBack,
        canForward: dock.history.canForward,
        scrollTop: dock.history.restored.scroll[id],
        body: view === null ? null : drawScreen(view.match, input.screen),
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
    onDoor: input.navigate,
    onBodyClick: (id, event) => {
      const panel = byId(id);
      const href = panel === null ? null : walkedLink(event);
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
