// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01's durable limit, the one limiter: a count read back from the records
// under a lock, against its maximum.

import { advisoryLock, type TenantQuery } from './database.ts';

/** One limit: what it counts, read from the records inside the transaction, and at most how many. */
export interface DurableLimit {
  /** Names the limit; the lock is this business's alone. */
  readonly name: string;
  readonly limit: number;
  readonly count: (tx: TenantQuery) => Promise<number>;
}

/**
 * Whether one more fits under every limit. Each count is read after its lock,
 * so under read committed (every tenant transaction's level; a snapshot taken
 * before the lock would miss rows) it sees what the lock's last holder
 * committed. The lock is held to commit: the caller writes the thing counted
 * before it ends.
 * Limits lock in the order given. The key names the business, so a business
 * at its limit never delays another. A limit that is not a whole number of at
 * least 1 has no room.
 */
export async function hasRoom(tx: TenantQuery, limits: readonly DurableLimit[]): Promise<boolean> {
  for (const { name, limit, count } of limits) {
    if (!Number.isSafeInteger(limit) || limit < 1) return false;
    // Sequential: each limit's lock, then its count, in the order given.
    // eslint-disable-next-line no-await-in-loop
    await advisoryLock(tx, `limit:${tx.businessId}:${name}`);
    // eslint-disable-next-line no-await-in-loop
    if ((await count(tx)) >= limit) return false;
  }
  return true;
}
