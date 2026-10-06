// SPDX-License-Identifier: AGPL-3.0-only
//
// The click-through seed's stop at the cap (SR-1): a picked-up run stopped at
// its ceiling as the broker stops it (`stopAtCeiling`), so the run waits for
// a person. A module of its own so its locks can be watched from a test.

import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { raiseBudgetWait } from '../../packages/core-custody/src/broker-wait.ts';
import { spentOn } from '../../packages/core-runtime/src/budget-stop.ts';

interface Held {
  readonly run_id: string;
  readonly delegation_id: string | null;
  readonly reservation_id: string;
  readonly version_id: string;
  readonly held: string;
}

/** Stop the run under `leaseId` at its ceiling, under the run, lease and reservation. */
export async function stopAtCeiling(
  database: Database,
  businessId: string,
  leaseId: string,
): Promise<void> {
  await database.withBusiness(businessId, async (tx) => {
    const [held] = await tx.query<Held>(
      `select l.run_id, l.delegation_id, r.id as reservation_id, r.version_id,
              r.held_minor::text as held
         from public.planned_runs run
         join public.leases l on l.business_id = run.business_id and l.run_id = run.id
         join public.reservations r on r.business_id = l.business_id and r.id = l.reservation_id
        where l.business_id = $1 and l.id = $2
          for update of run, l, r`,
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
  });
}
