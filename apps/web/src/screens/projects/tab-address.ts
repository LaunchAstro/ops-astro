// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects page's two tabs and the address that holds the open one: the
// board at `/projects/`, the Work log at `/projects/#worklog` (MP-8-4), so a
// reload lands on the tab that was open. ProjectsTabs.tsx draws the row.

import { useState } from 'react';
import { pathTo } from '../../routes.ts';

const WORK_LOG = '#worklog';

export const TABS = [
  { id: 'board', label: 'Board', href: pathTo('agency:projects-board') },
  { id: 'worklog', label: 'Work log', href: `${pathTo('agency:projects-board')}${WORK_LOG}` },
] as const;

/** A tab's id: the board or the Work log. */
type TabId = (typeof TABS)[number]['id'];

/** The tab an address holds: its fragment's. */
export const tabInAddress = (address: string): TabId =>
  new URL(address, 'http://here').hash === WORK_LOG ? 'worklog' : 'board';

/** The page's whole address, its fragment included, which a chosen tab writes. */
export const pageAddress = (): string => {
  const here = globalThis.location;
  return here === undefined ? '' : `${here.pathname}${here.search}${here.hash}`;
};

/** Keeps the address on the open tab, so a reload lands on it. */
export function writeTab(tab: TabId): void {
  const here = globalThis.location;
  if (here === undefined) return;
  const address = `${here.pathname}${here.search}${tab === 'worklog' ? WORK_LOG : ''}`;
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
    const next: TabId = id === 'worklog' ? 'worklog' : 'board';
    if (!inPanel) writeTab(next);
    setHeld({ address: here(), tab: next });
    if (next === 'worklog') setWorkLogOpened(true);
  };
  return { address, tab, select, workLogOpened };
}
