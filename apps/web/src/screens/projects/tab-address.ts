// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects page's two tabs and the address that holds the open one: the
// board at `/projects/`, the Work log at `/projects/#worklog` (MP-8-4), so a
// reload lands on the tab that was open. ProjectsTabs.tsx draws the row.

import { pathTo } from '../../routes.ts';

const WORK_LOG = '#worklog';

export const TABS = [
  { id: 'board', label: 'Board', href: pathTo('agency:projects-board') },
  { id: 'worklog', label: 'Work log', href: `${pathTo('agency:projects-board')}${WORK_LOG}` },
] as const;

/** A tab's id: the board or the Work log. */
type TabId = (typeof TABS)[number]['id'];

export const tabInAddress = (): TabId =>
  globalThis.location?.hash === WORK_LOG ? 'worklog' : 'board';

/** Keeps the address on the open tab, so a reload lands on it. */
export function writeTab(tab: TabId): void {
  const here = globalThis.location;
  if (here === undefined) return;
  const address = `${here.pathname}${here.search}${tab === 'worklog' ? WORK_LOG : ''}`;
  globalThis.history.replaceState(globalThis.history.state, '', address);
}
