// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08 seeds the launch for suites about what dispatch does after it.
//
// Dispatch releases an effect only for a reviewed output: the successor a
// handback wrote, whose accept is the launch (`reviewed-output.ts`). The
// aw-08 suites prove that path through the commands. Suites about the effect
// itself (marks, replay, reconcile, sweeps, alerts, drops) start from an
// approved lease, so they seed the mark the handback would have written on the
// version that lease works under, and keep their own money figures. The row
// goes through the same table and trigger: a version and lease on one lineage.

import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import type { Detail, Schedules } from './schedules-harness.ts';

const MARK = `insert into public.reviewed_outputs (business_id, version_id, lineage_id, lease_id)
  select l.business_id, res.version_id, run.lineage_id, l.id
    from public.leases l
    join public.reservations res on res.business_id = l.business_id and res.id = l.reservation_id
    join public.planned_runs run on run.business_id = l.business_id and run.id = l.run_id
   where l.business_id = $1 and l.id = $2
  returning version_id`;

function one(marked: readonly unknown[], leaseId: unknown): void {
  if (marked.length !== 1) throw new Error(`no lease ${String(leaseId)} to launch`);
}

/** Marks the version `leaseId` works under as a reviewed output in `business`. */
export async function seedLaunchOn(
  admin: AdminConnection,
  business: string,
  leaseId: unknown,
): Promise<void> {
  one(await admin.execute(MARK, [business, leaseId] as never), leaseId);
}

/** The same, in the caller's tenant transaction, as the handback writes it. */
export async function seedLaunchIn(tx: TenantQuery, leaseId: string): Promise<void> {
  one(await tx.query(MARK, [tx.businessId, leaseId]), leaseId);
}

/** The schedules' own business: the version `picked`'s lease works under, launched. */
export async function seedLaunch(s: Schedules, picked: Detail): Promise<void> {
  await seedLaunchOn(s.db.admin, s.business, picked['leaseId']);
}
