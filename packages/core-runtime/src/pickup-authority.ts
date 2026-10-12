// SPDX-License-Identifier: AGPL-3.0-only
//
// Whose authority a pickup claims under (`pickup.ts`): the claimant's grant subjects, whether the
// claimant may work the task at an instant, and, at a stop at a spent hold, the agent's live
// delegation for the purpose, which refuses the stop as `mintDelegation` refuses a second mint.

import { refuseCommand } from '../../core-records/src/index.ts';
import type { Subject, TenantQuery } from '../../core-records/src/index.ts';
import { lockedInstant } from './clock.ts';
import { personWriteLive } from './lease-ownership.ts';
import type { PickupRequest } from './pickup.ts';
import { checkAuthorityAt } from './recovery.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

/** What the claim found behind the reservation that its authority is judged on. */
interface Claimed {
  readonly task_id: string;
  readonly purpose: string;
}

/** Who the claim's authority is read from, as grant subjects. */
export function authoritySubjects(request: PickupRequest): readonly Subject[] {
  return request.claimant === 'person'
    ? [
        { kind: 'person', id: request.personId },
        { kind: 'actor', id: request.actorId },
      ]
    : [
        { kind: 'person', id: request.authorisedByPersonId },
        { kind: 'actor', id: request.mintedByActorId },
      ];
}

/**
 * The claimant's authority at the locked instant, read and never written: a
 * person's live write on the task, or the delegating person's live grants for
 * every action the agent's delegation would carry. Asked before a stop at a
 * spent hold commits its ask (`claimHold`), so a caller without it moves nothing.
 */
export async function claimantMayWork(
  tx: TenantQuery,
  request: PickupRequest,
  found: Claimed,
  lockedAt: string,
): Promise<RuntimeResult<undefined>> {
  if (request.claimant === 'person') {
    const person = { subjects: authoritySubjects(request), collection: request.collection };
    if (!(await personWriteLive(tx, person, found.task_id, lockedAt))) {
      return refuse(
        'SCOPE_NOT_GRANTED',
        'no live grant of yours covers work on this task',
        'Ask a manager for write on this task, or leave it for a holder who has it.',
      );
    }
    return { ok: true, value: undefined };
  }
  const actions = ['read', 'comment', 'write'] as const;
  for (const action of actions) {
    // Sequential, as the authority module's own check is: one transaction,
    // one connection.
    // oxlint-disable-next-line no-await-in-loop
    const delegable = await checkAuthorityAt(
      tx,
      [{ kind: 'person', id: request.authorisedByPersonId }],
      { collection: request.collection, action, scope: { kind: 'business', id: null } },
      lockedAt,
    );
    if (!delegable.ok) {
      return {
        ok: false,
        refusal: refuseCommand(
          'DELEGATION_WIDENS',
          [],
          [
            `the delegating person holds no live ${action} grant on ${request.collection}`,
            'narrow the purpose, or grant the person that authority first',
          ],
        ),
      };
    }
  }
  return { ok: true, value: undefined };
}

/**
 * The agent's live delegation for this purpose, refused as `mintDelegation`
 * refuses a second one: its row locked, its expiry judged after that wait at
 * the clock. A stop at a spent hold mints nothing, so it asks here, and the
 * refusal takes the stop's ask back with the rest of the transaction.
 */
async function liveDelegationRefusal(
  tx: TenantQuery,
  request: PickupRequest,
  found: Claimed,
): Promise<RuntimeResult<never> | null> {
  if (request.claimant === 'person') return null;
  const held = await tx.query<{ readonly id: string }>(
    `select id from public.delegations
      where business_id = $1 and agent_actor_id = $2 and purpose = $3
        and revoked_at is null and settled_at is null
      for update`,
    [tx.businessId, request.agentActorId, found.purpose],
  );
  if (held[0] === undefined) return null;
  const [judged] = await tx.query<{ readonly live: boolean }>(
    `select expires_at > clock_timestamp() as live from public.delegations
      where business_id = $1 and id = $2`,
    [tx.businessId, held[0].id],
  );
  if (judged?.live !== true) return null;
  return {
    ok: false,
    refusal: refuseCommand(
      'DELEGATION_ALREADY_LIVE',
      [],
      [
        `this agent already holds a live delegation for the purpose ${found.purpose}`,
        'Use the credential already issued for it, or hand the work back so the delegation settles.',
      ],
    ),
  };
}

/**
 * A stop at a spent hold keeps its ask (`stopped`), so only a claimant with the authority makes
 * it, and an agent already working the purpose under a live delegation is refused as its mint is.
 * The delegation's row is waited on first and the authority judged at the clock read after that
 * wait, never at an instant read before it: a grant that lapsed while the stop waited asks nothing.
 */
export async function keptStop(
  tx: TenantQuery,
  request: PickupRequest,
  found: Claimed,
  stopped: RuntimeResult<never>,
): Promise<RuntimeResult<never>> {
  const live = await liveDelegationRefusal(tx, request, found);
  const may = await claimantMayWork(tx, request, found, await lockedInstant(tx));
  if (!may.ok) return may;
  return live ?? stopped;
}
