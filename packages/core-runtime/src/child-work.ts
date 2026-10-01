// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11: a helper's work, from its one-call pickup to the parent's merged
// result: the hand-over.
//
//   delegateChild   the parent's holder hands part of its work to a helper on
//                   its own lease, at its own fence, in one transaction: the
//                   task, lease and parent delegation locked, the holder and
//                   fence re-checked (the heartbeat's own check), the child
//                   minted strictly narrower (`mintChildDelegation`, whose
//                   subset the database role also holds) and never past the
//                   lease's expiry, and a `delegated` run event written. The
//                   answer is everything the helper needs in one call.
//
// The helper's handback and the parent's merged result are
// `child-handback.ts`.
//
// The parent passed to `delegateChild` (and `childResults`) is the caller's own,
// resolved from its credential in this transaction (`resolveDelegation`); the
// hand-over binds it to the lease it names, so a delegation that does not hold
// that lease hands nothing over.

import { mintChildDelegation } from '../../core-records/src/index.ts';
import type {
  ChildMintRequest,
  CommandRefusal,
  Delegation,
  PurposeScope,
  TenantQuery,
} from '../../core-records/src/index.ts';
import { lockedInstant } from './clock.ts';
import type { FileIdentity } from './definitions.ts';
import { recheckOwner } from './heartbeat.ts';
import { refuseLease, type OwnerFixes } from './lease-ownership.ts';
import { acquire, type LockSet } from './locks.ts';
import { only } from './only.ts';
import { appendRunEvent } from './run-events.ts';

export type ChildWorkResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: CommandRefusal };

export interface DelegateChildRequest {
  readonly leaseId: string;
  readonly fence: number;
  readonly child: ChildMintRequest;
}

/** The helper's one call: everything it may act on, and what it cannot. */
export interface ChildPickup {
  readonly businessId: string;
  readonly childDelegationId: string;
  /** In the clear only in this answer; the delegation stores its digest. */
  readonly credential: string;
  readonly resource: {
    readonly taskId: string;
    readonly runId: string;
    readonly leaseId: string;
    readonly fence: number;
    readonly reservationId: string;
  };
  readonly approvedVersion: { readonly versionId: string; readonly taskRevision: number };
  /** `collection:action`, the child's own set. */
  readonly permittedOperations: readonly string[];
  /** The parent's envelope: the child spends on the parent's reservation. */
  readonly envelope: {
    readonly envelopeId: string;
    readonly currency: string;
    readonly heldMinor: number;
  };
  readonly actorScope: {
    readonly agentActorId: string;
    readonly delegatePersonId: string;
    readonly purposeScope: PurposeScope;
    readonly expiresAt: Date;
  };
  /** The run's pinned bootstrap file (AW-02), or null where the run has none. */
  readonly bootstrap: FileIdentity | null;
  readonly declaredIncompleteness: readonly string[];
}

const HAND_OVER_FIXES: OwnerFixes = {
  notOwned: 'Hand over part of the work on the lease your own pickup was issued, at its fence.',
  lost: 'A hand-over is made under current rights. Ask a manager for write on this task.',
  expired: 'A hand-over is made only while the lease is live. Pick the work up again.',
};

const CHILD_INCOMPLETENESS: readonly string[] = [
  'A helper hands its work back to its parent; it settles no lease or reservation of its own.',
  'A helper delegates no further: depth one.',
];

const NO_PIN =
  'This run has no pinned bootstrap file: the helper is handed no instruction file by pin.';

export async function delegateChild(
  tx: TenantQuery,
  parent: Delegation,
  request: DelegateChildRequest,
): Promise<ChildWorkResult<ChildPickup>> {
  const held = await lockHeldLease(tx, parent, request);
  if (!held.ok) return held;
  const { taskId, locks } = held.value;
  const facts = await leaseFacts(tx, request.leaseId);
  // The helper's authority ends with the parent's claim on the work.
  const leaseEnds = new Date(facts.lease_expires_at);
  const expiresAt =
    request.child.expiresAt.getTime() < leaseEnds.getTime() ? request.child.expiresAt : leaseEnds;
  const minted = await mintChildDelegation(tx, parent, { ...request.child, expiresAt });
  if (!minted.ok) return minted;
  const child = minted.value.delegation;
  await appendRunEvent(
    tx,
    {
      kind: 'delegated',
      taskId,
      runId: facts.run_id,
      leaseId: request.leaseId,
      attemptId: facts.attempt_id,
      actorId: parent.agentActorId,
      detail: { childDelegationId: child.id, helperActorId: child.agentActorId },
    },
    locks,
  );
  const bootstrap = await pinnedEntry(tx, facts.run_id);
  return {
    ok: true,
    value: {
      businessId: tx.businessId,
      childDelegationId: child.id,
      credential: minted.value.credential,
      ...pickupFacts(taskId, request, facts),
      ...childFacts(child),
      bootstrap,
      declaredIncompleteness:
        bootstrap === null ? [...CHILD_INCOMPLETENESS, NO_PIN] : CHILD_INCOMPLETENESS,
    },
  };
}

/**
 * The task, lease and parent delegation locked, then the heartbeat's own
 * check: the parent holds this lease at this fence, and both are live. A
 * lease this business does not hold is one the caller does not own.
 */
async function lockHeldLease(
  tx: TenantQuery,
  parent: Delegation,
  request: DelegateChildRequest,
): Promise<ChildWorkResult<{ readonly taskId: string; readonly locks: LockSet }>> {
  const found = await tx.query<{ readonly task_id: string }>(
    'select task_id from public.leases where business_id = $1 and id = $2',
    [tx.businessId, request.leaseId],
  );
  const taskId = found[0]?.task_id;
  if (taskId === undefined) return refuseLease('not_owned', HAND_OVER_FIXES.notOwned);
  const locks = await acquire(tx, [
    { lockClass: 'task', id: taskId },
    { lockClass: 'lease', id: request.leaseId },
    { lockClass: 'delegation', id: parent.id },
  ]);
  const caller = {
    claimant: 'agent',
    leaseId: request.leaseId,
    fence: request.fence,
    holderActorId: parent.agentActorId,
    delegationId: parent.id,
  } as const;
  const owned = await recheckOwner(tx, caller, await lockedInstant(tx), HAND_OVER_FIXES);
  return owned.ok ? { ok: true, value: { taskId, locks } } : owned;
}

interface LeaseFacts {
  readonly run_id: string;
  readonly reservation_id: string;
  readonly attempt_id: string;
  readonly lease_expires_at: Date;
  readonly version_id: string;
  readonly revision: string;
  readonly envelope_id: string;
  readonly currency: string;
  readonly held_minor: string;
}

async function leaseFacts(tx: TenantQuery, leaseId: string): Promise<LeaseFacts> {
  return only(
    await tx.query<LeaseFacts>(
      `select l.run_id, l.reservation_id, att.id as attempt_id, l.expires_at as lease_expires_at,
              res.version_id, r.revision::text as revision, res.envelope_id, env.currency,
              res.held_minor::text as held_minor
         from public.leases l
         join public.reservations res on res.business_id = l.business_id and res.id = l.reservation_id
         join public.task_envelopes env on env.business_id = res.business_id and env.id = res.envelope_id
         join public.records r on r.business_id = l.business_id and r.id = l.task_id
         join public.attempts att on att.business_id = l.business_id and att.lease_id = l.id
        where l.business_id = $1 and l.id = $2`,
      [tx.businessId, leaseId],
    ),
    "delegateChild: the held lease's run, reservation, attempt and envelope",
  );
}

/** The child's own set and scope, as the helper is handed them. */
function childFacts(child: Delegation): Pick<ChildPickup, 'permittedOperations' | 'actorScope'> {
  return {
    permittedOperations: child.collections
      .flatMap((collection) => child.actions.map((action) => `${collection}:${action}`))
      .toSorted(),
    actorScope: {
      agentActorId: child.agentActorId,
      delegatePersonId: child.delegatePersonId,
      purposeScope: child.purposeScope,
      expiresAt: child.expiresAt,
    },
  };
}

function pickupFacts(
  taskId: string,
  request: DelegateChildRequest,
  facts: LeaseFacts,
): Pick<ChildPickup, 'resource' | 'approvedVersion' | 'envelope'> {
  return {
    resource: {
      taskId,
      runId: facts.run_id,
      leaseId: request.leaseId,
      fence: request.fence,
      reservationId: facts.reservation_id,
    },
    approvedVersion: { versionId: facts.version_id, taskRevision: Number(facts.revision) },
    envelope: {
      envelopeId: facts.envelope_id,
      currency: facts.currency,
      heldMinor: Number(facts.held_minor),
    },
  };
}

async function pinnedEntry(tx: TenantQuery, runId: string): Promise<FileIdentity | null> {
  const pins = await tx.query<{
    readonly path: string;
    readonly content_digest: string;
    readonly content_size: string;
  }>(
    `select path, content_digest, content_size::text as content_size
       from public.run_definition_pins
      where business_id = $1 and run_id = $2 and ref_kind = 'bootstrap_file'`,
    [tx.businessId, runId],
  );
  const pin = pins[0];
  return pin === undefined
    ? null
    : { path: pin.path, digest: pin.content_digest, size: Number(pin.content_size) };
}
