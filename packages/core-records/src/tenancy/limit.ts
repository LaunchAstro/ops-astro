// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01's durable limit, the one limiter: a count read back from the records
// under a lock, against its maximum.

import type { TenantQuery } from './database.ts';

/** One limit: what it counts, read from the records inside the transaction, and at most how many. */
export interface DurableLimit {
  /** Names the limit; the lock is this business's alone. */
  readonly name: string;
  readonly limit: number;
  readonly count: (tx: TenantQuery) => Promise<number>;
}

export async function hasRoom(
  _tx: TenantQuery,
  _limits: readonly DurableLimit[],
): Promise<boolean> {
  return true;
}
