// SPDX-License-Identifier: AGPL-3.0-only
//
// THE DOCK: the right edge as a place. A 40px rail of permanent tabs floats
// centred on the right edge, and the open panels sit beside it in the order
// they are handed, each with a head: its name, the door to its view's own
// address, one divider, back, forward and its X.
//
// This component holds no session state. Which panels are open, where each
// one is and what a press means belong to `apps/web`, which hands the result
// here and hears every press back [ui-reference CONTRACT.md:305 rule 3]. What
// is measured here is layout: whether the rail sits so near the window's left
// edge that its callout must open to the right, and where a grip is dragged.
//
// The grip sets one width for every panel (MP-3-2) and, below the side tier,
// the sheet's one height (MP-3-3), by pointer or by the same separator's keys:
// the arrows step it, shift steps it further, Home resets it. Nothing
// animates until the first layout is drawn.

import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { Icon, type GlyphName } from '../primitives/Icon.tsx';
import { DockPanelView, type DockPanel, type DockPanelActs } from './DockPanel.tsx';
import { EdgeGrip } from './EdgeGrip.tsx';

export interface DockTab {
  readonly id: string;
  readonly label: string;
  /** The panel's glyph, as the mockup registers each panel with one; the grid glyph when none is named. */
  readonly icon?: GlyphName | undefined;
  /** The count chip's text, or null for no chip. */
  readonly count: string | null;
  readonly open: boolean;
}

export type { DockPanel, DockPanelActs } from './DockPanel.tsx';

export interface DockLayout {
  readonly mode: 'rest' | 'seated' | 'floating' | 'sheet' | 'phone';
  /** The one width every open panel is drawn at. */
  readonly panelWidth: number;
  /** Below the side tier: the one sheet height, and the most the window allows. */
  readonly sheetHeight?: number;
  readonly sheetMax?: number;
}

/** The panel floor and default: the grip never offers less, and Home returns to the default. */
export const DOCK_PANEL_FLOOR = 380;
export const DOCK_PANEL_DEFAULT = 550;
export const DOCK_SHEET_FLOOR = 220;
export const DOCK_SHEET_DEFAULT = 460;

export interface DockProps extends DockPanelActs {
  readonly tabs: readonly DockTab[];
  readonly layout?: DockLayout;
  /** One width for every panel, while the grip moves. */
  readonly onResize?: (width: number) => void;
  /** The width the grip was let go at, to keep. */
  readonly onResizeEnd?: (width: number) => void;
  /** The sheet's one height, while its grip moves. */
  readonly onSheetResize?: (height: number) => void;
  /** The height the sheet's grip was let go at, to keep. */
  readonly onSheetResizeEnd?: (height: number) => void;
  /** One line saying why the dock changed on its own (R39), or null. */
  readonly stamp?: string | null;
  /** The open panels, in the order they are drawn. */
  readonly panels: readonly DockPanel[];
  readonly onTab: (id: string, shift: boolean) => void;
  readonly onCloseAll: () => void;
  /** Out of reach while the narrow drawer holds the focus (MP-2-8). */
  readonly inert?: boolean;
}

/** How near the window's left edge the rail may sit before its callout opens rightwards. */
const TIP_FLIP_PX = 150;

export function Dock(props: DockProps): ReactElement {
  const [flip, setFlip] = useState(false);
  const ready = useReadyAfterFirstLayout();
  const [dragging, setDragging] = useState(false);
  const anyOpen = props.panels.length > 0;
  const width = props.layout?.panelWidth ?? DOCK_PANEL_DEFAULT;
  const height = props.layout?.sheetHeight ?? DOCK_SHEET_DEFAULT;
  const style = {
    '--dock-panel-w': `${String(width)}px`,
    '--dock-sheet-h': `${String(height)}px`,
  } as CSSProperties;
  return (
    <div
      className={`dock${flip ? ' dock--tipflip' : ''}`}
      data-open={anyOpen ? String(props.panels.length) : '0'}
      data-mode={props.layout?.mode ?? (anyOpen ? 'floating' : 'rest')}
      style={style}
      inert={props.inert}
      {...(ready ? { 'data-ready': '' } : {})}
      {...(dragging ? { 'data-dragging': '' } : {})}
    >
      {props.stamp === undefined || props.stamp === null ? null : (
        <p className="dock__stamp" role="status">
          {props.stamp}
        </p>
      )}
      {anyOpen ? (
        <div className="dock__panels">
          {props.panels.map((panel, index) => (
            <DockPanelView
              key={panel.id}
              panel={panel}
              dock={props}
              grip={
                <PanelGrip
                  dock={props}
                  topmost={index === props.panels.length - 1}
                  width={width}
                  height={height}
                  onDragging={setDragging}
                />
              }
            />
          ))}
        </div>
      ) : null}
      <DockRail dock={props} anyOpen={anyOpen} onFlip={setFlip} />
    </div>
  );
}

/**
 * The grip on a panel's edge. Beside the page it sets one width for every
 * panel; below the side tier the panels share one height, dragged on the
 * sheet's top edge, so only the topmost panel carries it: the sheet stacks
 * from the bottom edge up in rank order, so that is the last one handed.
 */
function PanelGrip(props: {
  readonly dock: DockProps;
  readonly topmost: boolean;
  readonly width: number;
  readonly height: number;
  readonly onDragging: (dragging: boolean) => void;
}): ReactElement | null {
  const { dock } = props;
  const sheet = dock.layout?.mode === 'sheet' || dock.layout?.mode === 'phone';
  if (sheet) {
    return props.topmost ? (
      <EdgeGrip
        edge="top"
        className="dpanel__grip"
        label="Sheet height"
        value={props.height}
        min={DOCK_SHEET_FLOOR}
        max={dock.layout?.sheetMax}
        reset={DOCK_SHEET_DEFAULT}
        per={1}
        onDragging={props.onDragging}
        onChange={dock.onSheetResize}
        onCommit={dock.onSheetResizeEnd}
      />
    ) : null;
  }
  return (
    <EdgeGrip
      edge="left"
      className="dpanel__grip"
      label="Panel width"
      value={props.width}
      min={DOCK_PANEL_FLOOR}
      reset={DOCK_PANEL_DEFAULT}
      per={dock.panels.length}
      onDragging={props.onDragging}
      onChange={dock.onResize}
      onCommit={dock.onResizeEnd}
    />
  );
}

function DockRail(props: {
  readonly dock: DockProps;
  readonly anyOpen: boolean;
  readonly onFlip: (flip: boolean) => void;
}): ReactElement {
  const measure = (event: { readonly currentTarget: HTMLElement }): void => {
    props.onFlip(event.currentTarget.getBoundingClientRect().left < TIP_FLIP_PX);
  };
  return (
    <nav className="dock__rail" aria-label="Side panels" onMouseOver={measure} onFocus={measure}>
      {props.dock.tabs.map((tab) => (
        <DockTabButton key={tab.id} tab={tab} onTab={props.dock.onTab} />
      ))}
      {props.anyOpen ? (
        <button
          className="dock__tab dock__closeall"
          type="button"
          aria-label="Close all panels"
          onClick={props.dock.onCloseAll}
        >
          <Icon name="cross-small" />
        </button>
      ) : null}
    </nav>
  );
}

function DockTabButton(props: {
  readonly tab: DockTab;
  readonly onTab: DockProps['onTab'];
}): ReactElement {
  const { tab } = props;
  return (
    <button
      className="dock__tab"
      type="button"
      data-panel={tab.id}
      aria-expanded={tab.open}
      aria-label={`${tab.open ? 'Close' : 'Open'} ${tab.label}${tab.count === null ? '' : `, ${tab.count} unread`}`}
      onClick={(event) => {
        props.onTab(tab.id, event.shiftKey);
      }}
    >
      {/* The icon slot: the panel's glyph from the licensed set (MP-1-2),
          never an initial or an emoji. Decoration: the button's label names
          the panel. */}
      <Icon name={tab.icon ?? 'apps'} />
      {tab.count === null ? null : (
        <span className="cbadge dock__n" aria-hidden="true">
          {tab.count}
        </span>
      )}
      {/* The callout names the tab on hover and focus. The button's label
          already says it, so the callout is hidden from it. */}
      <span className="dock__tablabel" aria-hidden="true">
        {tab.label}
      </span>
    </button>
  );
}

/** False until two frames after the first layout, so the first paint never animates. */
export function useReadyAfterFirstLayout(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setReady(true);
    }, 34);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return ready;
}
