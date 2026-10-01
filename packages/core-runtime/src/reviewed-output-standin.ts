// SPDX-License-Identifier: AGPL-3.0-only
//
// STAND-IN for AW-08 (a)'s reviewed-output marker (migration 0213). The (a)
// fork's real module replaces this one at the join; the launch gate
// (`launch-gate.ts`) is its only caller, through this one function.
//
// Until then the one durable fact that already tells a plan from its output
// stands in: a version whose approval is bound in `plan_records` (0207) was
// approved as a plan (AW-04's accept), so it is not a reviewed output and its
// approval is not the launch. Every other approved version reads as reviewed.

import type { TenantQuery } from '../../core-records/src/index.ts';

/** Whether `versionId` is a reviewed output: a version whose approval may launch its effect. */
export async function isReviewedOutput(tx: TenantQuery, versionId: string): Promise<boolean> {
  const rows = await tx.query<{ readonly plan: boolean }>(
    `select exists (select 1 from public.plan_records pr
                      join public.gates g on g.business_id = pr.business_id and g.id = pr.gate_id
                     where pr.business_id = $1 and g.version_id = $2) as plan`,
    [tx.businessId, versionId],
  );
  return rows[0]?.plan !== true;
}
