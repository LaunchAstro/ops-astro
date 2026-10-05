// SPDX-License-Identifier: AGPL-3.0-only
//
// The fleet table's view state (MP-14-7a): a placeholder whose rules are
// not built yet, so the cases that pin them fail on their values.

export type SortKey = 'status' | 'source' | 'clients' | 'lastPass' | 'freshness' | 'quota';
export type Direction = 'asc' | 'desc';
export type Tone = 'idle' | 'ok' | 'warn' | 'bad';

export const FIRST_DIRECTION: Readonly<Record<SortKey, Direction>> = {
  status: 'asc',
  source: 'asc',
  freshness: 'asc',
  clients: 'asc',
  lastPass: 'asc',
  quota: 'asc',
};

export function initialFleetView(): {
  readonly sort: { readonly key: SortKey; readonly direction: Direction };
} {
  return { sort: { key: 'source', direction: 'asc' } };
}

export function freshnessOf(
  _row: { readonly lastSyncedAt: string | null; readonly cadenceMinutes: number },
  _now: number,
): { readonly daysBehind: number | null; readonly tone: Tone } {
  return { daysBehind: null, tone: 'idle' };
}
