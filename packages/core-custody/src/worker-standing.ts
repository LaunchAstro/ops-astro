// SPDX-License-Identifier: AGPL-3.0-only
//
// The standing every system send holds: the business's worker actor, active,
// inside the send's own reservation (AW-01 J: system writes run under a
// worker, never a person's grant). The inbox passes (`email-worker.ts`) and
// the owed invitation's send (`broker-invitation.ts`) both read it here.

import { isUuid, type TenantQuery } from '../../core-records/src/index.ts';
/**
 * The worker actor, held `for share` and active: a deactivation in flight is waited on and then
 * read, and one that comes later waits for this transaction's end. The recheck relies on the
 * order in each send: custody is asked only after the send's transaction commits, so the one
 * send a deactivation can still meet is one that held the worker first.
 */
export async function activeWorker(tx: TenantQuery, actorId: string): Promise<boolean> {
  if (!isUuid(actorId)) return false;
  const rows = await tx.query<{ readonly id: string }>(
    `select id from public.actors
      where business_id = $1 and id = $2 and kind = 'worker' and active for share`,
    [tx.businessId, actorId],
  );
  return rows.length === 1;
}
