// SPDX-License-Identifier: AGPL-3.0-only
//
// A `task.pickup` sent under a delegation credential answers to that
// delegation (ROUTE1905, S2113-1). The worker claims owner work only on the
// task its own delegation names, so the claim is judged last against it, once
// the agent's judgement holds the row `for share` (`agent-standing.ts`): a
// revocation committed before then refuses the claim, and one after waits.

import { resolveDelegation, type TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

const OUT_OF_PURPOSE_FIXES: readonly string[] = [
  'This work is on a task the presented delegation does not name: it was not claimed.',
];

/**
 * The presented delegation, after the agent's last judgement holds it `for
 * share` (`agent-standing.ts`): live at this instant, and naming the task the
 * claim took. Otherwise the claim rolls back with the refusal.
 */
export async function delegationReaches(
  tx: TenantQuery,
  agentActorId: string,
  credential: string,
  taskId: string | null,
): Promise<CommandRefusal | undefined> {
  const resolved = await resolveDelegation(tx, agentActorId, credential);
  if (!resolved.ok) return resolved.refusal;
  if (resolved.value.purposeScope.id.toLowerCase() === taskId?.toLowerCase()) return undefined;
  return refuseCommand('DELEGATION_OUT_OF_PURPOSE', ['task.pickup'], OUT_OF_PURPOSE_FIXES);
}
