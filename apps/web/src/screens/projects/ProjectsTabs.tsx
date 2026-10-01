// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects page's two tabs, drawn as the tab row (DS-COMP-2): links to the
// page's own addresses (`/projects/` and `/projects/#worklog`), the current one
// marked `aria-current`, so they read as the mockup's row of pages. They keep
// the tab set's keyboard (Tabs.tsx): one stop for the row, the arrow keys,
// Home and End move within it, and each tab names the pane it shows.

import type { KeyboardEvent, MouseEvent, ReactElement } from 'react';

export interface ProjectsTab {
  readonly id: string;
  readonly label: string;
  /** The tab's address: the page itself, or the page at a fragment. */
  readonly href: string;
}

/** The ids TabPanel pairs with (Tabs.tsx), so each pane is labelled by its tab. */
const tabId = (name: string, tab: string): string => `${name}-tab-${tab}`;
const panelId = (name: string, tab: string): string => `${name}-panel-${tab}`;

/** The tab a key moves to: the arrows wrap, Home and End go to the ends; any other key, none. */
function keyedTab(key: string, index: number, count: number): number | null {
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

export interface ProjectsTabsProps {
  readonly label: string;
  /** The tab set's name: the prefix of each tab's and pane's id. */
  readonly name: string;
  readonly tabs: readonly ProjectsTab[];
  readonly selected: string;
  readonly onSelect: (id: string) => void;
}

export function ProjectsTabs(props: ProjectsTabsProps): ReactElement {
  const index = props.tabs.findIndex((tab) => tab.id === props.selected);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const to = keyedTab(event.key, index, props.tabs.length);
    const next = to === null ? undefined : props.tabs[to];
    if (next === undefined) return;
    event.preventDefault();
    props.onSelect(next.id);
    event.currentTarget.querySelector<HTMLElement>(`#${tabId(props.name, next.id)}`)?.focus();
  };
  return (
    <nav
      className="routetabs"
      role="tablist"
      aria-label={props.label}
      data-tabs={props.name}
      onKeyDown={onKeyDown}
    >
      {props.tabs.map((tab) => {
        const on = tab.id === props.selected;
        return (
          <a
            key={tab.id}
            className="routetabs__t"
            href={tab.href}
            role="tab"
            id={tabId(props.name, tab.id)}
            aria-selected={on}
            aria-controls={panelId(props.name, tab.id)}
            tabIndex={on ? 0 : -1}
            {...(on ? { 'aria-current': 'page' as const } : {})}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              // A plain press switches in place; a modified one opens the address.
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              props.onSelect(tab.id);
            }}
          >
            {tab.label}
          </a>
        );
      })}
    </nav>
  );
}
