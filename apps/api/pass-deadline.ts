// SPDX-License-Identifier: AGPL-3.0-only
//
// One deadline for a whole reconciliation pass (#2240, #1411). The function's
// request waits the pass out, so the pass, not the request, holds the bound:
// each of its transactions stops waiting on a lock at the deadline and rolls back.

import type { Database } from '../../packages/core-records/src/index.ts';

/** The shortest lock wait a transaction begun near or past the deadline still gets. */
const LOCK_WAIT_FLOOR_MS = 100;

/** `database`, each transaction rolled back once a lock wait runs past `deadline`. */
export const lockWaitsUntil = (database: Database, deadline: number): Database => ({
  ...database,
  withBusiness: async (businessId, run) =>
    await database.withBusiness(businessId, async (tx) => {
      const left = Math.max(LOCK_WAIT_FLOOR_MS, deadline - Date.now());
      await tx.query(`select set_config('lock_timeout', $1, true)`, [`${String(left)}ms`]);
      return await run(tx);
    }),
});
