// SPDX-License-Identifier: AGPL-3.0-only
//
// A `task.pickup` sent under a delegation credential answers to that
// delegation and the chain above it (ROUTE1905, S2113-1, S2113-3). The worker
// claims owner work only on the task its own delegation names, so the claim is
// judged last against it in the claim's own transaction, once the agent's
// judgement holds the delegation `for share` (`agent-standing.ts`) and this
// holds its parent the same way: a revocation of either committed before then
// refuses the claim, and one after waits for it.

import {
  DELEGATION_STANDS_AT_CHECK,
  resolveDelegation,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

const OUT_OF_PURPOSE_FIXES: readonly string[] = [
  'This work is on a task the presented delegation does not name: it was not claimed.',
];

const NOT_LIVE_FIXES: readonly string[] = ['ask the authorising person for a current delegation'];

/**
 * The presented delegation, after the agent's last judgement holds it `for
 * share`: live, its parent too (children go one level deep), at this instant,
 * and naming the task the claim took. Otherwise the claim rolls back with the
 * refusal.
 */
export async function delegationReaches(
  tx: TenantQuery,
  agentActorId: string,
  credential: string,
  taskId: string | null,
): Promise<CommandRefusal | undefined> {
  const resolved = await resolveDelegation(tx, agentActorId, credential);
  if (!resolved.ok) return resolved.refusal;
  const { id, parentDelegationId, purposeScope } = resolved.value;
  // Locked alone first: a locking select computes its columns before it waits.
  if (parentDelegationId !== null) {
    await tx.query(
      'select 1 from public.delegations where business_id = $1 and id = $2 for share',
      [tx.businessId, parentDelegationId],
    );
  }
  const [chain] = await tx.query<{ readonly stands: boolean }>(
    `select ${DELEGATION_STANDS_AT_CHECK} as stands from public.delegations d
      where d.business_id = $1 and d.id = $2`,
    [tx.businessId, id],
  );
  if (chain?.stands !== true) return refuseCommand('DELEGATION_NOT_LIVE', [], NOT_LIVE_FIXES);
  if (purposeScope.id.toLowerCase() === taskId?.toLowerCase()) return undefined;
  return refuseCommand('DELEGATION_OUT_OF_PURPOSE', ['task.pickup'], OUT_OF_PURPOSE_FIXES);
}
