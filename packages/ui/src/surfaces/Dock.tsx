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

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Icon, type GlyphName } from '../primitives/Icon.tsx';
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

export interface DockPanel {
  readonly id: string;
  /** The panel's name. The head never names the item open inside it. */
  readonly label: string;
  readonly ariaLabel: string;
  /** The address of the view the panel is on, or of its board. */
  readonly door: string;
  /** The door's glyph: its destination's own (DK-09); the in-app arrow when none is named. */
  readonly icon?: GlyphName | undefined;
  readonly canBack: boolean;
  readonly canForward: boolean;
  /** Where the last walk of the dock's history puts this panel's scroll, if anywhere. */
  readonly scrollTop?: number | undefined;
  readonly body: ReactNode;
}

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

export interface DockProps {
  readonly tabs: readonly DockTab[];
  readonly layout?: DockLayout;
  /** One width for every panel, while the grip moves. */
  readonly onResize?: (width: number) => void;
  /** The width the grip was let go at, to keep. */
  readonly onResizeEnd?: (width: number) => void;
  /** The sheet's one height, while its grip moves and when it is let go. */
  readonly onSheetResize?: (height: number) => void;
  /** Which walk of the history the panels' scrollTop belongs to; each new walk applies it once. */
  readonly restoreWalk?: number;
  /** A panel's body scrolled. */
  readonly onScroll?: (id: string, top: number) => void;
  /** One line saying why the dock changed on its own (R39), or null. */
  readonly stamp?: string | null;
  /** The open panels, in the order they are drawn. */
  readonly panels: readonly DockPanel[];
  readonly onTab: (id: string, shift: boolean) => void;
  readonly onClose: (id: string) => void;
  readonly onCloseAll: () => void;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onDoor: (href: string) => void;
  /** A click inside a panel's body, which may walk the panel rather than the page. */
  readonly onBodyClick?: (id: string, event: MouseEvent<HTMLDivElement>) => void;
}

/** How near the window's left edge the rail may sit before its callout opens rightwards. */
const TIP_FLIP_PX = 150;

export function Dock(props: DockProps): ReactElement {
  const [flip, setFlip] = useState(false);
  const measure = (event: { readonly currentTarget: HTMLElement }): void => {
    setFlip(event.currentTarget.getBoundingClientRect().left < TIP_FLIP_PX);
  };
  const ready = useReadyAfterFirstLayout();
  const [dragging, setDragging] = useState(false);
  const anyOpen = props.panels.length > 0;
  const width = props.layout?.panelWidth ?? DOCK_PANEL_DEFAULT;
  const height = props.layout?.sheetHeight ?? DOCK_SHEET_DEFAULT;
  // Below the side tier the panels share one height, dragged on the sheet's top edge.
  const sheet = props.layout?.mode === 'sheet' || props.layout?.mode === 'phone';
  return (
    <div
      className={`dock${flip ? ' dock--tipflip' : ''}`}
      data-open={anyOpen ? String(props.panels.length) : '0'}
      data-mode={props.layout?.mode ?? (anyOpen ? 'floating' : 'rest')}
      style={
        {
          '--dock-panel-w': `${String(width)}px`,
          '--dock-sheet-h': `${String(height)}px`,
        } as CSSProperties
      }
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
                sheet ? (
                  index === 0 ? (
                    <EdgeGrip
                      edge="top"
                      className="dpanel__grip"
                      label="Sheet height"
                      value={height}
                      min={DOCK_SHEET_FLOOR}
                      max={props.layout?.sheetMax}
                      reset={DOCK_SHEET_DEFAULT}
                      per={1}
                      onDragging={setDragging}
                      onChange={props.onSheetResize}
                      onCommit={props.onSheetResize}
                    />
                  ) : null
                ) : (
                  <EdgeGrip
                    edge="left"
                    className="dpanel__grip"
                    label="Panel width"
                    value={width}
                    min={DOCK_PANEL_FLOOR}
                    reset={DOCK_PANEL_DEFAULT}
                    per={props.panels.length}
                    onDragging={setDragging}
                    onChange={props.onResize}
                    onCommit={props.onResizeEnd}
                  />
                )
              }
            />
          ))}
        </div>
      ) : null}
      <nav className="dock__rail" aria-label="Side panels" onMouseOver={measure} onFocus={measure}>
        {props.tabs.map((tab) => (
          <DockTabButton key={tab.id} tab={tab} onTab={props.onTab} />
        ))}
        {anyOpen ? (
          <button
            className="dock__tab dock__closeall"
            type="button"
            aria-label="Close all panels"
            onClick={props.onCloseAll}
          >
            <Icon name="cross-small" />
          </button>
        ) : null}
      </nav>
    </div>
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
      aria-label={`${tab.open ? 'Close' : 'Open'} ${tab.label}${tab.count === null ? '' : `, ${tab.count}`}`}
      onClick={(event) => {
        props.onTab(tab.id, event.shiftKey);
      }}
    >
      {/* The icon slot: the panel's glyph from the licensed set (MP-1-2),
          never an initial or an emoji. Decoration: the button's label names
          the panel. */}
      <Icon name={tab.icon ?? 'apps'} />
      {tab.count === null ? null : (
        <span className="dock__n" aria-hidden="true">
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

function DockPanelView(props: {
  readonly panel: DockPanel;
  readonly dock: DockProps;
  readonly grip: ReactNode;
}): ReactElement {
  const { panel, dock } = props;
  const body = useRef<HTMLDivElement>(null);
  const top = panel.scrollTop;
  // A walk of the history puts the panel's scroll back, once per walk.
  useLayoutEffect(() => {
    if (top !== undefined && body.current !== null) body.current.scrollTop = top;
  }, [dock.restoreWalk, top]);
  return (
    <section className="dpanel" data-panel-id={panel.id} aria-label={panel.ariaLabel}>
      {props.grip}
      <header className="dpanel__head">
        <h2 className="dpanel__name">{panel.label}</h2>
        <div className="dpanel__acts">
          <a
            className="dpanel__btn"
            data-act="door"
            href={panel.door}
            aria-label={`Open ${panel.label} as a page`}
            onClick={(event) => {
              event.preventDefault();
              dock.onDoor(panel.door);
            }}
          >
            <Icon name={panel.icon ?? 'arrow-small-right'} />
          </a>
          <span className="dpanel__div" aria-hidden="true" />
          <HistoryButton act="back" able={panel.canBack} onPress={dock.onBack} />
          <HistoryButton act="forward" able={panel.canForward} onPress={dock.onForward} />
          <button
            className="dpanel__btn dpanel__x"
            type="button"
            data-act="close"
            aria-label={`Close ${panel.label}`}
            onClick={() => {
              dock.onClose(panel.id);
            }}
          >
            <Icon name="cross-small" />
          </button>
        </div>
      </header>
      {/* A click here is heard, not handled: the application decides whether
          a link walks the panel. Keyboard activation of a link is a click. */}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        ref={body}
        className="dpanel__body"
        onClick={(event) => {
          dock.onBodyClick?.(panel.id, event);
        }}
        onScroll={(event) => {
          dock.onScroll?.(panel.id, event.currentTarget.scrollTop);
        }}
      >
        {panel.body}
      </div>
    </section>
  );
}

function HistoryButton(props: {
  readonly act: 'back' | 'forward';
  readonly able: boolean;
  readonly onPress: () => void;
}): ReactElement {
  const label = props.act === 'back' ? 'Back, where the dock was' : 'Forward, where the dock was';
  // Disabled but never hidden, and still focusable, so the head keeps its shape
  // and a keyboard user can learn the control is there.
  return (
    <button
      className="dpanel__btn"
      type="button"
      data-act={props.act}
      aria-label={label}
      aria-disabled={!props.able}
      onClick={() => {
        if (props.able) props.onPress();
      }}
    >
      <Icon name={props.act === 'back' ? 'angle-small-left' : 'angle-small-right'} />
    </button>
  );
}
