// SPDX-License-Identifier: AGPL-3.0-only
//
// The fleet table's view state (MP-14-7a, CS-14.13): which status facet is
// pressed, the sort, how many rows are shown and which are open. None of it
// is stored or sent: a facet, a sort, an expansion or "show more" changes
// what this page draws from the rows it already holds, and nothing else
// (AG-C12, AG-C14, AG-C15, AG-C19 are "not audited" view state).
//
// The rules are the mockup's (`docs/mockup-inventory/AGENCY.md`, AG-C12 to
// AG-C19): the page shows 10 rows and "show more" adds 10; a facet or a sort
// returns to the first 10; the first sort is Clients descending; a column's
// first direction is ascending for Status, Source and Freshness and
// descending for Clients, Last pass and Quota; the active column flips.

import type { ConnectionView } from '../../../../../packages/core-wire/src/index.ts';

export type Facet = 'all' | ConnectionView['status'];
export type SortKey = 'status' | 'source' | 'clients' | 'lastPass' | 'freshness' | 'quota';
export type Direction = 'asc' | 'desc';
export type Tone = 'idle' | 'ok' | 'warn' | 'bad';

export const PAGE = 10;

export const FIRST_DIRECTION: Readonly<Record<SortKey, Direction>> = {
  status: 'asc',
  source: 'asc',
  freshness: 'asc',
  clients: 'desc',
  lastPass: 'desc',
  quota: 'desc',
};

export interface FleetView {
  readonly facet: Facet;
  readonly sort: { readonly key: SortKey; readonly direction: Direction };
  readonly shown: number;
  readonly open: ReadonlySet<string>;
}

export function initialFleetView(): FleetView {
  return {
    facet: 'all',
    sort: { key: 'clients', direction: 'desc' },
    shown: PAGE,
    open: new Set(),
  };
}

export function withFacet(view: FleetView, facet: Facet): FleetView {
  return { ...view, facet, shown: PAGE };
}

/** The active column flips; another column starts at its first direction. */
export function withSort(view: FleetView, key: SortKey): FleetView {
  const direction =
    view.sort.key === key ? (view.sort.direction === 'asc' ? 'desc' : 'asc') : FIRST_DIRECTION[key];
  return { ...view, sort: { key, direction }, shown: PAGE };
}

export function showMore(view: FleetView): FleetView {
  return { ...view, shown: view.shown + PAGE };
}

export function toggleOpen(view: FleetView, id: string): FleetView {
  const open = new Set(view.open);
  if (open.has(id)) open.delete(id);
  else open.add(id);
  return { ...view, open };
}

const DAY = 86_400_000;

/**
 * How far behind a connection's data is, and its tone. The tone is read
 * against the connection's own cadence: within one cadence it is on time
 * (`idle` for a source that syncs less often than daily, since it is not
 * expected to have moved, `ok` otherwise); up to four cadences late it is
 * `warn`; beyond that, or never synced, `bad`. For a daily source that is the
 * mockup's T-1 ok, T-4 warn, worse bad.
 */
export function freshnessOf(
  row: { readonly lastSyncedAt: string | null; readonly cadenceMinutes: number },
  now: number,
): { readonly daysBehind: number | null; readonly tone: Tone } {
  if (row.lastSyncedAt === null) return { daysBehind: null, tone: 'bad' };
  const age = Math.max(0, now - Date.parse(row.lastSyncedAt));
  const cadence = row.cadenceMinutes * 60_000;
  const daysBehind = Math.floor(age / DAY);
  if (age <= cadence) return { daysBehind, tone: cadence > DAY ? 'idle' : 'ok' };
  if (age <= 4 * cadence) return { daysBehind, tone: 'warn' };
  return { daysBehind, tone: 'bad' };
}

/** A source that has stopped: broken, or its data out beyond four cadences. */
export function isStuck(row: ConnectionView, now: number): boolean {
  return row.status === 'broken' || freshnessOf(row, now).tone === 'bad';
}

const STATUS_RANK: Readonly<Record<ConnectionView['status'], number>> = {
  active: 0,
  degraded: 1,
  broken: 2,
};

function sortValue(row: ConnectionView, key: SortKey, now: number): number | string {
  switch (key) {
    case 'status':
      return STATUS_RANK[row.status];
    case 'source':
      return row.label.toLowerCase();
    case 'clients':
      return row.clients.length;
    case 'lastPass':
      return row.lastAttemptAt === null ? Number.NEGATIVE_INFINITY : Date.parse(row.lastAttemptAt);
    case 'freshness':
      return freshnessOf(row, now).daysBehind ?? Number.POSITIVE_INFINITY;
    case 'quota':
      // Quota burn arrives with the phase 6 sources (MP-14-7b); until then
      // every row ties and the label decides.
      return 0;
  }
}

/** The rows the view draws, and how many the facet holds in all. */
export function visibleRows(
  rows: readonly ConnectionView[],
  view: FleetView,
  now: number,
): { readonly rows: readonly ConnectionView[]; readonly total: number } {
  const filtered = view.facet === 'all' ? rows : rows.filter((row) => row.status === view.facet);
  const sign = view.sort.direction === 'asc' ? 1 : -1;
  const sorted = filtered.toSorted((a, b) => {
    const left = sortValue(a, view.sort.key, now);
    const right = sortValue(b, view.sort.key, now);
    if (left < right) return -sign;
    if (left > right) return sign;
    return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
  });
  return { rows: sorted.slice(0, view.shown), total: filtered.length };
}
