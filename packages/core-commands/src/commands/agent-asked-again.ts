// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent task write's authority, asked again after its waits: under the task
// or comment lock (`askedAgain`), and once more after the audit chain's key
// (`askedLast`, the write's `lastCheck`). Split from `agent-operations.ts` to
// keep that file under the line limit.

import { checkDelegatedAuthority, resolveDelegation } from '../../../core-records/src/index.ts';
import type { Delegation, TenantQuery } from '../../../core-records/src/index.ts';
import type { AgentCall } from './agent-call.ts';
import { isRefused, type HandlerOutcome } from './outcome.ts';
import type { CommandRefusal } from './refusal.ts';

/**
 * The agent entry's authority asked again once the task or comment is locked,
 * as `authorise` asked it. The delegation and, for a helper, its parent are
 * held `for share` first, after the task (the global order's delegation
 * class): a `delegation.revoke` writes the row, so one that has not committed
 * waits for the change. The grants are read, not held: `grant.revoke` takes
 * its grant before the task (`LOCK_ORDER`), so holding them here would invert
 * that order. A helper has no lease of its own and revoking it takes no task
 * lock, so nothing else orders that revocation with this change.
 */
export async function askedAgain(
  tx: TenantQuery,
  { session, declaration, credential }: AgentCall,
  delegation: Delegation,
  task: { readonly id: string },
): Promise<CommandRefusal | undefined> {
  const chain = [delegation.id, delegation.parentDelegationId].filter(
    (id): id is string => id !== null,
  );
  await tx.query(
    `select id from public.delegations
      where business_id = $1 and id = any($2::uuid[])
      order by id
      for share`,
    [tx.businessId, chain],
  );
  const again = await resolveDelegation(tx, session.actorId, credential ?? '');
  if (!again.ok) return again.refusal;
  const decision = await checkDelegatedAuthority(tx, again.value, {
    collection: declaration.collection,
    action: declaration.action,
    scope: { kind: 'record', id: task.id },
  });
  return decision.ok ? undefined : decision.refusal;
}

/**
 * An applied task write asks its authority once more after the agent's last
 * wait, the audit chain's (`lastCheck`, `agent-standing.ts`): a grant that ran
 * out while the write waited there refuses it and keeps nothing.
 */
export const askedLast = (
  outcome: HandlerOutcome,
  again: () => Promise<CommandRefusal | undefined>,
): HandlerOutcome => (isRefused(outcome) ? outcome : { ...outcome, lastCheck: again });
