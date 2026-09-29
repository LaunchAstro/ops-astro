// SPDX-License-Identifier: AGPL-3.0-only
//
// The fleet table's view state (MP-14-7a): not built yet.

export type SortKey = 'status' | 'source' | 'clients' | 'lastPass' | 'freshness' | 'quota';
export type Direction = 'asc' | 'desc';
export type Tone = 'idle' | 'ok' | 'warn' | 'bad';

export const FIRST_DIRECTION: Readonly<Record<SortKey, Direction>> = {} as Record<
  SortKey,
  Direction
>;

export function initialFleetView(): {
  readonly sort: { readonly key: SortKey; readonly direction: Direction };
} {
  throw new Error('not built');
}

export function freshnessOf(
  _row: { readonly lastSyncedAt: string | null; readonly cadenceMinutes: number },
  _now: number,
): { readonly daysBehind: number | null; readonly tone: Tone } {
  throw new Error('not built');
}
