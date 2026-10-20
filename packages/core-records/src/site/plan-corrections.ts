// SPDX-License-Identifier: AGPL-3.0-only
//
// #1717: an accepted plan version holds one agent-drafted correction. The
// plan version is the server's read of the pickup delegation's lease, and the
// correction already stored for it answers a second request. Both read inside
// the caller's business only. `insertLiveCorrection` stores the version
// (`NewLiveCorrection.planVersionId`, null for a person's request) and stores
// nothing for a version that holds one (`live_corrections_one_per_plan_idx`),
// a second request at once waiting on the first's insert.

import type { TenantQuery } from '../tenancy/database.ts';
import { COLUMNS, correctionFrom, type Row, type StoredCorrection } from './live-corrections.ts';

/** The correction an agent drafted for `planVersionId` in this business, if one is stored (#1717). */
export async function correctionOfPlan(
  tx: TenantQuery,
  planVersionId: string,
): Promise<StoredCorrection | undefined> {
  const [row] = await tx.query<Row>(
    `select ${COLUMNS} from public.live_corrections c
      where c.business_id = $1 and c.plan_version_id = $2`,
    [tx.businessId, planVersionId],
  );
  return row === undefined ? undefined : correctionFrom(row);
}

/**
 * The plan version the work a pickup delegation was minted for serves, read
 * from its lease's reservation in this business; undefined for a delegation
 * no pickup minted (#1717).
 */
export async function planVersionOfDelegation(
  tx: TenantQuery,
  delegationId: string,
): Promise<string | undefined> {
  const [row] = await tx.query<{ readonly version_id: string }>(
    `select r.version_id from public.leases l
       join public.reservations r on r.business_id = l.business_id and r.id = l.reservation_id
      where l.business_id = $1 and l.delegation_id = $2`,
    [tx.businessId, delegationId],
  );
  return row?.version_id;
}
