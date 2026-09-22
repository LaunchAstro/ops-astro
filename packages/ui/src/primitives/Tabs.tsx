// SPDX-License-Identifier: AGPL-3.0-only
//
// The sliding tab set, with the keyboard the pinned mockup does not have.
//
// **This is the one place the port deliberately adds behaviour rather than
// carrying it.** At the pinned revision both tab strips on the task page are
// click-delegated only: no `keydown` listener anywhere in the five files, no
// roving tabindex, no arrow keys, no `role="tabpanel"` on the panes and no
// `aria-controls`/`aria-labelledby` linking a tab to what it shows. Every tab
// is a native button, so Enter and Space work and that is the whole keyboard
// story.
//
// The precedence rule makes the mockup's aesthetic the authority over the drawn
// surface; it does not make a missing keyboard an aesthetic. The candidate's
// own first-UI-ticket list requires keyboard, focus and narrow-screen checks
// [docs/design-system.md], so the pattern is completed here and the addition is
// recorded in `DECISIONS.tsv` rather than smuggled in as a port.
//
// The sliding mark is CSS-positioned from the selected tab rather than measured
// in JavaScript, because a measurement needs a layout and this package must
// render on a server as well as in a browser.

import type { KeyboardEvent, ReactElement, ReactNode } from 'react';

export interface TabDescriptor {
  /** Stable within the strip, and the anchor for the `aria-controls` pairing. */
  readonly id: string;
  readonly label: string;
  /** Drawn to the right of the label. Absent when there is nothing to count. */
  readonly badge?: ReactElement | null;
}

export interface TabStripProps {
  /** Announced to a reader who arrives on the strip with nothing else for context. */
  readonly label: string;
  readonly tabs: readonly TabDescriptor[];
  readonly selected: string;
  readonly onSelect: (id: string) => void;
  /** Distinguishes two strips on one page, so their identifiers cannot collide. */
  readonly name: string;
}

export function TabStrip(props: TabStripProps): ReactElement {
  const index = props.tabs.findIndex((tab) => tab.id === props.selected);
  const move = (by: number): void => {
    const count = props.tabs.length;
    if (count === 0) return;
    const next = props.tabs[(((index + by) % count) + count) % count];
    if (next !== undefined) props.onSelect(next.id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Left and right only. Up and down belong to the page's own scroll, and a
    // strip that swallows them is a strip a reader cannot escape.
    if (event.key === 'ArrowRight') move(1);
    else if (event.key === 'ArrowLeft') move(-1);
    else if (event.key === 'Home') move(-index);
    else if (event.key === 'End') move(props.tabs.length - 1 - index);
    else return;
    event.preventDefault();
  };
  return (
    <div
      className="cmtabs"
      role="tablist"
      aria-label={props.label}
      onKeyDown={onKeyDown}
      data-tabs={props.name}
    >
      {props.tabs.map((tab) => {
        const on = tab.id === props.selected;
        return (
          <button
            key={tab.id}
            className="cmtab"
            type="button"
            role="tab"
            id={tabId(props.name, tab.id)}
            aria-selected={on}
            aria-controls={panelId(props.name, tab.id)}
            // The roving tabindex: one stop for the whole strip, and the arrow
            // keys move within it. Nine tabs are one Tab press, not nine.
            tabIndex={on ? 0 : -1}
            onClick={() => {
              props.onSelect(tab.id);
            }}
          >
            {tab.label}
            {tab.badge ?? null}
          </button>
        );
      })}
      <span className="cmtabs__mark" aria-hidden="true" />
    </div>
  );
}

export interface TabPanelProps {
  readonly name: string;
  readonly tab: string;
  readonly selected: string;
  readonly children: ReactNode;
}

/**
 * The pane. Hidden by attribute and never unmounted, which is the pinned
 * behaviour: the mockup toggles `hidden` and never re-renders, so a reading
 * position and a scroll offset survive a switch.
 */
export function TabPanel(props: TabPanelProps): ReactElement {
  const on = props.tab === props.selected;
  return (
    <div
      id={panelId(props.name, props.tab)}
      role="tabpanel"
      aria-labelledby={tabId(props.name, props.tab)}
      tabIndex={0}
      hidden={!on}
    >
      {props.children}
    </div>
  );
}

const tabId = (name: string, tab: string): string => `${name}-tab-${tab}`;
const panelId = (name: string, tab: string): string => `${name}-panel-${tab}`;
