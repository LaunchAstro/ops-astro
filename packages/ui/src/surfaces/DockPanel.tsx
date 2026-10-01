// SPDX-License-Identifier: AGPL-3.0-only
//
// One open panel of the dock: its head (its name, the door to its view's own
// address, one divider, back, forward and its X) over its body. What a press
// or a click inside the body means is the application's; this draws it.

import { useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react';
import type { MouseEvent } from 'react';
import { Icon, type GlyphName } from '../primitives/Icon.tsx';

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

/** What a panel hears and hands back: the application decides what each press means. */
export interface DockPanelActs {
  /** Which walk of the history the panels' scrollTop belongs to; each new walk applies it once. */
  readonly restoreWalk?: number;
  /** A panel's body scrolled. */
  readonly onScroll?: (id: string, top: number) => void;
  readonly onClose: (id: string) => void;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onDoor: (href: string) => void;
  /** A click inside a panel's body, which may walk the panel rather than the page. */
  readonly onBodyClick?: (id: string, event: MouseEvent<HTMLDivElement>) => void;
}

export function DockPanelView(props: {
  readonly panel: DockPanel;
  readonly dock: DockPanelActs;
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
      <DockPanelHead panel={panel} dock={dock} />
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

function DockPanelHead(props: {
  readonly panel: DockPanel;
  readonly dock: DockPanelActs;
}): ReactElement {
  const { panel, dock } = props;
  return (
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
