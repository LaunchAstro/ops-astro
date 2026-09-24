// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.pickup`: an agent or a person claims an approved reservation. Split out
// unchanged when the one task-runtime module was divided (thermo review
// b483399, H2).

import type { TenantQuery } from '../tenancy/database.ts';
import { pickup } from '../../../core-runtime/src/index.ts';
import {
  NOT_CLAIMABLE_FIX,
  NOT_CLAIMABLE_REASON,
  type PickedUp,
  type PickedUpByPerson,
} from '../../../core-runtime/src/pickup.ts';
import type { CommandContext } from './context.ts';
import { isIdentifier } from './operands.ts';
import { fromReasoned, refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome, type Refused } from './outcome.ts';
import { delegationCredentialKeys } from './runtime-config.ts';
import { handbackShapeFor } from './pickup-handback-shape.ts';
import { readLeaseSeconds } from './tasks-lease.ts';
import { agentClaimant, personClaimant, type Claimant } from './tasks-claimant.ts';

/** How long a lease runs when the caller names nothing. Bounded, and the server's. */
const DEFAULT_LEASE_SECONDS = 15 * 60;
export const MAXIMUM_LEASE_SECONDS: number = 60 * 60;

export interface PickupFields {
  readonly reservationId: string;
  readonly leaseSeconds?: number;
}

/**
 * The agent's own identity picks the reservation up, and the authority it will
 * carry is **not** its own.
 *
 * `authorisedByPersonId` is read from the approving decision rather than taken
 * from the payload, which is the load-bearing part. The delegation's ceiling
 * is the live grants of the person who approved the work — `checkDelegatedAuthority`
 * asks `effectiveGrants` what that person holds on every call — so a body that
 * could name the authorising person would be a body that could name whose
 * authority the agent borrows. There is no field for it here for the same
 * reason there is no field for `actorId`.
 */
export async function pickupReservation(
  tx: TenantQuery,
  collection: string,
  agentActorId: string,
  fields: PickupFields,
): Promise<HandlerOutcome> {
  // An agent's pickup mints a credential, and the credential is derived under
  // the deployment's delegation key. Without one there is no credential this
  // deployment could give back after a lost response, so nothing is claimed.
  // The same answer as a decision with no signing key: not about the caller,
  // and retrying will not change it.
  const keys = delegationCredentialKeys();
  if (!keys.ok) {
    return refused(
      refuseCommand(
        'DEPENDENCY_NOT_LANDED',
        ['task.pickup', 'DELEGATION_CREDENTIAL_KEY_ID and DELEGATION_CREDENTIAL_KEYS'],
        [
          'This deployment has no usable delegation credential key.',
          'It is not a permission problem and retrying will not change it.',
        ],
      ),
    );
  }
  return await claim(tx, collection, fields, agentClaimant(agentActorId));
}

/**
 * A `reservationId` that is not a string, in one body for both entries
 * (THERMO-RECHECK-2 NNA4; the agent's `pickupOperands`). No attempted value:
 * the two audit rows are the same row (`tests/api/id-operand-shape.test.ts`).
 */
export function refuseReservationBody(): Refused {
  return refused(
    refuseCommand(
      'COMMAND_BODY_INVALID',
      ['reservationId'],
      ['Name a reservation from task.queue.'],
    ),
  );
}

/**
 * The verified person picks the reservation up as themselves (EX-01, T3 line
 * 66). The holder is the session's own actor and the authority is the
 * session's own live grants, re-read under the claim's locks; the approving
 * person is still read from the decision and kept on the lease as the recorded
 * work authorisation, never as the claimant's authority. No delegation is
 * minted and no credential is returned, because there is no agent.
 */
export async function pickupAsPerson(
  tx: TenantQuery,
  context: CommandContext,
  fields: PickupFields,
): Promise<HandlerOutcome> {
  // An HTTP body is untyped. Absent is the body's shape; present and not an
  // identifier names nothing, and answers exactly as a fabricated one does.
  const named: unknown = fields.reservationId;
  if (typeof named !== 'string') return refuseReservationBody();
  return await claim(tx, context.declaration.collection, fields, personClaimant(context));
}

/** The runtime's own answer for a reservation nobody may claim, not a second spelling. */
function notClaimable(): Refused {
  return refused(
    refuseCommand('RESERVATION_NOT_CLAIMABLE', [], [NOT_CLAIMABLE_REASON, NOT_CLAIMABLE_FIX]),
  );
}

async function claim(
  tx: TenantQuery,
  collection: string,
  fields: PickupFields,
  claimant: Claimant,
): Promise<HandlerOutcome> {
  const seconds = readLeaseSeconds(fields, DEFAULT_LEASE_SECONDS, MAXIMUM_LEASE_SECONDS);
  if (typeof seconds !== 'number') return seconds;
  // Both claimants come through here, the agent's envelope with whatever
  // string it was sent. A reservation id that cannot exist names nothing, and
  // answers as one that does not exist, before it reaches a uuid parameter.
  if (!isIdentifier(fields.reservationId)) {
    return notClaimable();
  }

  const approver = await approvingPerson(tx, fields.reservationId);
  if (approver === undefined) {
    // No approval behind this reservation, or no reservation. Either way there
    // is nothing here a worker may claim, and the runtime's own code for that
    // is the one to answer with rather than a second spelling. The runtime
    // gives the same two sentences for a reservation somebody else holds.
    return notClaimable();
  }

  const common = {
    reservationId: fields.reservationId,
    authorisedByPersonId: approver.personId,
    collection,
    leaseSeconds: seconds,
  };
  const result =
    claimant.claimant === 'person'
      ? await pickup(tx, {
          ...common,
          claimant: 'person',
          personId: claimant.personId,
          actorId: claimant.actorId,
        })
      : await pickup(tx, {
          ...common,
          claimant: 'agent',
          agentActorId: claimant.actorId,
          mintedByActorId: approver.actorId,
        });
  if (!result.ok) return refused(fromReasoned(result.refusal));
  return applied(result.value.taskId, null, pickupDetail(result.value));
}

/**
 * What the claimed work does not reach, each named with its reason
 * (TRANSACTION-CONTRACT line 64, minimum contract lines 139 and 337), so the
 * claimant never spends a call finding out.
 */
function exclusionsFor(
  claimant: 'agent' | 'person',
): readonly { readonly operation: string; readonly reason: string }[] {
  return [
    {
      operation: 'effect dispatch',
      reason: 'this head exports no effect dispatch and no provider adapter',
    },
    {
      operation: 'actual expenditure',
      reason: 'nothing in this head dispatches, so nothing is spent; a handback reports none',
    },
    {
      operation: 'task.decide on this work',
      reason:
        claimant === 'agent'
          ? 'a delegation never carries decide: a person decides'
          : 'a lease carries work, not a decision: deciding is its own gate operation, never taken through this lease',
    },
  ];
}
/**
 * T1-R8's one-call payload for the actual claimant. The delegation half is
 * the agent's alone: a person's result has no delegation id, no credential and
 * no purpose scope, rather than a placeholder for any of them.
 */
function pickupDetail(picked: PickedUp | PickedUpByPerson): Record<string, unknown> {
  const common = {
    claimant: picked.claimant,
    leaseId: picked.leaseId,
    fence: picked.fence,
    reservationId: picked.reservationId,
    attemptId: picked.attemptId,
    taskId: picked.taskId,
    runId: picked.runId,
    versionId: picked.versionId,
    expiresAt: picked.expiresAt.toISOString(),
    declaredIncompleteness: picked.declaredIncompleteness,
    holderActorId: picked.holderActorId,
    authorisedByPersonId: picked.authorisedByPersonId,
    brief: picked.brief,
    expectedVersions: picked.expectedVersions,
    budgetEnvelope: picked.budgetEnvelope,
    permittedOperations: ['task.read', 'task.comment', 'task.heartbeat', 'task.handback'],
    excludedOperations: exclusionsFor(picked.claimant),
    handbackShape: handbackShapeFor(picked),
  };
  if (picked.claimant === 'person') return common;
  return {
    ...common,
    // In the clear only in this answer. The delegation stores its digest and
    // the register keeps this detail with the credential nulled
    // (`agent-envelope.ts`, `storable`). A replay of this pickup, after the
    // current-rights and lease checks, derives the same value again from the
    // delegation's pinned key and checks it against that digest.
    delegationId: picked.delegation.delegation.id,
    credential: picked.delegation.credential,
    purposeScope: picked.delegation.delegation.purposeScope,
  };
}

interface Approver {
  readonly personId: string;
  readonly actorId: string;
}

/** The person whose approval put this reservation on the queue. */
async function approvingPerson(
  tx: TenantQuery,
  reservationId: string,
): Promise<Approver | undefined> {
  const rows = await tx.query<{
    readonly decided_by_person_id: string;
    readonly decided_by_actor_id: string;
  }>(
    `select d.decided_by_person_id, d.decided_by_actor_id
       from public.reservations res
       join public.gate_decisions d
         on d.business_id = res.business_id and d.version_id = res.version_id
      where res.business_id = $1 and res.id = $2 and d.decision = 'approve'
      order by d.seq desc
      limit 1`,
    [tx.businessId, reservationId],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { personId: row.decided_by_person_id, actorId: row.decided_by_actor_id };
}
