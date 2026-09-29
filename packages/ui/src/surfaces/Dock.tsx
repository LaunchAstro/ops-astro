// SPDX-License-Identifier: AGPL-3.0-only
//
// THE DOCK: the right edge as a place. A 40px rail of permanent tabs floats
// centred on the right edge, and the open panels sit beside it in the order
// they are handed, each with a head: its name, the door to its view's own
// address, one divider, back, forward and its X.
//
// This component holds no session state. Which panels are open, where each
// one is and what a press means belong to `apps/web`, which hands the result
// here and hears every press back [ui-reference CONTRACT.md:305 rule 3]. The
// one thing measured here is layout: whether the rail sits so near the
// window's left edge that its callout must open to the right.

import { useId, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';

export interface DockTab {
  readonly id: string;
  readonly label: string;
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
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly body: ReactNode;
}

export interface DockLayout {
  readonly mode: 'rest' | 'seated' | 'floating' | 'sheet';
  readonly panelWidth: number;
}

export interface DockProps {
  readonly tabs: readonly DockTab[];
  /** MP-3-2 stub. */
  readonly layout?: DockLayout;
  readonly onResize?: (width: number) => void;
  readonly onResizeEnd?: (width: number) => void;
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
  const anyOpen = props.panels.length > 0;
  return (
    <div
      className={`dock${flip ? ' dock--tipflip' : ''}`}
      data-open={anyOpen ? String(props.panels.length) : '0'}
    >
      {anyOpen ? (
        <div className="dock__panels">
          {props.panels.map((panel) => (
            <DockPanelView key={panel.id} panel={panel} dock={props} />
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
            <span className="dock__glyph" aria-hidden="true">
              ×
            </span>
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
  const tip = useId();
  return (
    <button
      className="dock__tab"
      type="button"
      data-panel={tab.id}
      aria-expanded={tab.open}
      aria-describedby={tip}
      aria-label={`${tab.open ? 'Close' : 'Open'} ${tab.label}${tab.count === null ? '' : `, ${tab.count}`}`}
      onClick={(event) => {
        props.onTab(tab.id, event.shiftKey);
      }}
    >
      {/* The icon slot carries the panel's initial until the kit's icon set
          lands (MP-1-2); never an emoji, which the design system forbids. */}
      <span className="dock__glyph" aria-hidden="true">
        {tab.label.slice(0, 1)}
      </span>
      {tab.count === null ? null : (
        <span className="dock__n" aria-hidden="true">
          {tab.count}
        </span>
      )}
      <span className="dock__tip" role="tooltip" id={tip}>
        {tab.label}
      </span>
    </button>
  );
}

function DockPanelView(props: {
  readonly panel: DockPanel;
  readonly dock: DockProps;
}): ReactElement {
  const { panel, dock } = props;
  return (
    <section className="dpanel" data-panel-id={panel.id} aria-label={panel.ariaLabel}>
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
            <span aria-hidden="true">↗</span>
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
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </header>
      {/* A click here is heard, not handled: the application decides whether
          a link walks the panel. Keyboard activation of a link is a click. */}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        className="dpanel__body"
        onClick={(event) => {
          dock.onBodyClick?.(panel.id, event);
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
      <span aria-hidden="true">{props.act === 'back' ? '‹' : '›'}</span>
    </button>
  );
}
