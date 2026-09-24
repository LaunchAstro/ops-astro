// SPDX-License-Identifier: AGPL-3.0-only
//
// The delegation check an agent call answers to, in the order AUTHORITY.md
// puts it, chosen by the operation's `authority` row (`agent-operations.ts`).

import type { TenantQuery } from '../tenancy/database.ts';
import {
  checkDelegatedAuthority,
  resolveDelegation,
  type Delegation,
} from '../authority/delegations.ts';
import { decideAsAgent } from '../../../core-runtime/src/index.ts';
import { fromRuntime, refuseCommand, type CommandRefusal } from './refusal.ts';
import { declarationOf } from './surface.ts';
import type { AgentCall, AgentOperation, AgentRequest } from './agent-operations.ts';
import { isUuid } from '../tenancy/ids.ts';

export const NO_DELEGATION_FIXES: readonly string[] = [
  'Present the credential the pickup handed you.',
  'Before a pickup an agent login may only read task.queue and call task.pickup.',
];

const PRE_PICKUP_DECISION_FIXES: readonly string[] = [
  'A person decides, with their own credential.',
  ...NO_DELEGATION_FIXES.slice(1),
];

/**
 * What `authorise` answered: the refusal, or the delegation the call goes
 * ahead under, handed on so no later step resolves the credential again. The
 * pre-pickup pair goes ahead under none.
 */
export type Authorisation =
  { readonly refusal: CommandRefusal } | { readonly delegation: Delegation | undefined };

const refusing = (refusal: CommandRefusal): Authorisation => ({ refusal });

/**
 * The delegation check, in the order AUTHORITY.md puts it.
 *
 * Returns the refusal, or the delegation when the call may go ahead. The pre-pickup
 * pair short-circuits it: there is no delegation to intersect with, and the
 * two operations they are bounded to are the ones that cannot touch a task's
 * own data — the queue names reservations and a pickup claims one.
 */
export async function authorise(
  tx: TenantQuery,
  { session, credential, request }: AgentCall,
  operation: AgentOperation,
): Promise<Authorisation> {
  if (operation.authority === 'beforePickup') return { delegation: undefined };

  // No credential is an agent login before any pickup, and it reaches the two
  // operations above and nothing else (minimum contract 8.2 case 9): an
  // exclusion, named for what was asked, and a decision named as one.
  if (credential === undefined || credential === '') {
    return refusing(
      operation.authority === 'decision'
        ? refuseCommand(
            'DELEGATION_EXCLUDES_DECISION',
            [request.command],
            PRE_PICKUP_DECISION_FIXES,
          )
        : refuseCommand('DELEGATION_EXCLUDES_OPERATION', [request.command], NO_DELEGATION_FIXES),
    );
  }
  const resolved = await resolveDelegation(tx, session.actorId, credential);
  if (!resolved.ok) return refusing(fromRuntime(resolved.refusal));
  const delegation = resolved.value;

  // Under a live delegation the agent may ask what it may do: the answer is
  // that delegation's purpose and the pairs of it the delegating person still
  // covers (`capabilitiesOf`). It is an assertion that the agent reaches its
  // task, so it is answered only while the delegation and the person's current
  // grants intersect on that task (root ruling 5). The check is the least the
  // answer claims: `read` on the purpose record. When the person has lost it,
  // the agent is told `DELEGATION_NARROWED` rather than shown a scope it
  // cannot use.
  if (operation.authority === 'purpose') {
    const reach = await checkDelegatedAuthority(tx, delegation, {
      collection: delegation.collections[0] ?? 'task',
      action: 'read',
      scope: delegation.purposeScope,
    });
    return reach.ok ? { delegation } : refusing(fromRuntime(reach.refusal));
  }

  const taskId = await subjectTaskId(tx, delegation, request, operation);

  if (operation.authority === 'decision') {
    // L4 asks L2 and returns L2's answer. It cannot succeed: `DelegableAction`
    // excludes `decide`, the check refuses it first, and a delegation carrying
    // it cannot be written at all. An ordinary write of one is refused by
    // `delegations_actions_known` (0008:188), the constraint Postgres reports;
    // `delegations_never_decide` (0008:186) is the named second barrier.
    const excluded = await decideAsAgent(tx, delegation, {
      collection: 'task',
      taskId,
    });
    return refusing(fromRuntime(excluded.ok ? unreachable() : excluded.refusal));
  }

  const declaration = declarationOf(request.command);
  const decision = await checkDelegatedAuthority(tx, delegation, {
    collection: declaration?.collection ?? 'task',
    action: declaration?.action ?? 'read',
    // Always the record, never the business: a business-scoped request under a
    // delegation is outside its purpose by construction, and the one-task
    // ceiling is the whole of what `purposeScope` buys.
    scope: { kind: 'record', id: taskId },
  });
  return decision.ok ? { delegation } : refusing(fromRuntime(decision.refusal));
}

function unreachable(): never {
  throw new Error('agent-envelope: decideAsAgent permitted a decision');
}

/**
 * The task a call is about.
 *
 * A handback names a lease rather than a task, so the task is read from the
 * lease before the authority check rather than taken from the body: an agent
 * that could name the task its handback is "about" could satisfy the one-task
 * check with its own task while settling somebody else's lease. Anything that
 * resolves to nothing falls back to the delegation's own scope, which then
 * either matches — and the operation refuses on its own terms — or does not.
 */
async function subjectTaskId(
  tx: TenantQuery,
  delegation: Delegation,
  request: AgentRequest,
  operation: AgentOperation,
): Promise<string> {
  // The id as sent: `String([id])` is the id, and the array itself would then
  // reach the bound parameter (Sol 6 AUTHORITY-2).
  const leaseId = request['leaseId'];
  if (operation.subjectTask === 'lease' && isUuid(leaseId)) {
    const rows = await tx.query<{ readonly task_id: string }>(
      `select task_id from public.leases where business_id = $1 and id = $2`,
      [tx.businessId, leaseId],
    );
    return rows[0]?.task_id ?? delegation.purposeScope.id;
  }
  const named = request['recordId'];
  return typeof named === 'string' ? named : delegation.purposeScope.id;
}
