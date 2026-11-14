// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects page's tabs and the address that holds the open one: the
// board at `/projects/`, the Work log at `/projects/#worklog` (MP-8-4) and the
// deleted tasks at `/projects/#deleted` (#2346), so a reload lands on the tab
// that was open. ProjectsTabs.tsx draws the row.

import { useState } from 'react';
import { pathTo } from '../../routes.ts';

const WORK_LOG = '#worklog';
const DELETED = '#deleted';

export const TABS = [
  { id: 'board', label: 'Board', href: pathTo('agency:projects-board') },
  { id: 'worklog', label: 'Work log', href: `${pathTo('agency:projects-board')}${WORK_LOG}` },
  { id: 'deleted', label: 'Deleted', href: `${pathTo('agency:projects-board')}${DELETED}` },
] as const;

/** A tab's id: the board, the Work log or the deleted tasks. */
type TabId = (typeof TABS)[number]['id'];

const FRAGMENTS: Readonly<Record<TabId, string>> = {
  board: '',
  worklog: WORK_LOG,
  deleted: DELETED,
};

/** The tab an id names; any other id, the board. */
const tabOf = (id: string): TabId => (id === 'worklog' || id === 'deleted' ? id : 'board');

/** The tab an address holds: its fragment's. */
export const tabInAddress = (address: string): TabId => {
  const hash = new URL(address, 'http://here').hash;
  return hash === WORK_LOG ? 'worklog' : hash === DELETED ? 'deleted' : 'board';
};

/** The page's whole address, its fragment included, which a chosen tab writes. */
export const pageAddress = (): string => {
  const here = globalThis.location;
  return here === undefined ? '' : `${here.pathname}${here.search}${here.hash}`;
};

/** Keeps the address on the open tab, so a reload lands on it. */
export function writeTab(tab: TabId): void {
  const here = globalThis.location;
  if (here === undefined) return;
  const address = `${here.pathname}${here.search}${FRAGMENTS[tab]}`;
  globalThis.history.replaceState(globalThis.history.state, '', address);
}

/**
 * The open tab and its address: a panel's own place, never the page's
 * fragment, or the page's. A chosen tab holds while that address does; a new
 * address opens on its own tab, and the Work log, once drawn, stays drawn.
 */
export function useProjectsTab(panelAddress: string | undefined, inPanel: boolean) {
  const here = (): string => (inPanel ? (panelAddress ?? '') : pageAddress());
  const address = here();
  const [held, setHeld] = useState(() => ({ address, tab: tabInAddress(address) }));
  const [workLogOpened, setWorkLogOpened] = useState(held.tab === 'worklog');
  if (held.address !== address) {
    const next = tabInAddress(address);
    setHeld({ address, tab: next });
    if (next === 'worklog') setWorkLogOpened(true);
  }
  const tab: TabId = held.address === address ? held.tab : tabInAddress(address);
  const select = (id: string): void => {
    const next = tabOf(id);
    if (!inPanel) writeTab(next);
    setHeld({ address: here(), tab: next });
    if (next === 'worklog') setWorkLogOpened(true);
  };
  return { address, tab, select, workLogOpened };
}
