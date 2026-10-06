// SPDX-License-Identifier: AGPL-3.0-only
//
// The click-through seed's stop at the cap (SR-1): a picked-up run stopped at
// its ceiling as the broker stops it (`stopAtCeiling`), so the run waits for
// a person. A module of its own so its locks can be watched from a test.
//
// The locks are the product's set, in the product's order (`acquire`): cap,
// envelope, task, run, lineage, lease, delegation, reservation, as the
// recovery classifier and cancellation take them. Revoking the delegation
// clears the task it is assigned to, so a stop that took the run before the
// task could wait on a cancellation waiting on it. A deadlock the server
// breaks anyway is tried once more, as the command envelope tries it.

import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { raiseBudgetWait } from '../../packages/core-custody/src/broker-wait.ts';
import { spentOn } from '../../packages/core-runtime/src/budget-stop.ts';
import { acquire } from '../../packages/core-runtime/src/locks.ts';
import {
  AFFECTED_COLUMNS,
  AFFECTED_JOINS,
  locksFor,
  type Affected,
} from '../../packages/core-runtime/src/recovery/classifier.ts';
import { retryOnce } from '../../packages/core-commands/src/commands/envelope.ts';

interface Held {
  readonly run_id: string;
  readonly delegation_id: string | null;
  readonly reservation_id: string;
  readonly version_id: string;
  readonly held: string;
}

/** Stop the run under `leaseId` at its ceiling, under its whole lock set. */
export async function stopAtCeiling(
  database: Database,
  businessId: string,
  leaseId: string,
): Promise<void> {
  await retryOnce(
    async () =>
      await database.withBusiness(businessId, async (tx) => {
        // Found without locks, then locked in order, then read again under them.
        const affected = await tx.query<Affected>(
          `select ${AFFECTED_COLUMNS} ${AFFECTED_JOINS}
            where res.business_id = $1 and res.lease_id = $2`,
          [tx.businessId, leaseId],
        );
        if (affected.length === 0) throw new Error(`click-through-seed: no hold on ${leaseId}`);
        await acquire(tx, locksFor(affected));
        const [held] = await tx.query<Held>(
          `select l.run_id, l.delegation_id, r.id as reservation_id, r.version_id,
                  r.held_minor::text as held
             from public.leases l
             join public.reservations r on r.business_id = l.business_id and r.id = l.reservation_id
            where l.business_id = $1 and l.id = $2`,
          [tx.businessId, leaseId],
        );
        if (held === undefined) throw new Error(`click-through-seed: no lease ${leaseId} to stop`);
        await raiseBudgetWait(tx, {
          runId: held.run_id,
          leaseId,
          delegationId: held.delegation_id,
          reservationId: held.reservation_id,
          versionId: held.version_id,
          ceilingMinor: Number(held.held),
          spentMinor: (await spentOn(tx, held.reservation_id)).spent,
        });
      }),
  );
}
