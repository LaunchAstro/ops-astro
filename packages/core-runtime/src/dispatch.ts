// SPDX-License-Identifier: AGPL-3.0-only
//
// T2c1: the dispatch transaction. The lease holder asks to mark its step
// dispatched, and the mark commits on its own, before any effect is applied
// (T2c2 applies it).
//
// **The recheck is inside.** The four effect-time facts the execution-owner
// contract names are read under this transaction's locks, at the instant read
// after them, and never before: the grant rows the work's authority rests on
// are held `for share` first, so a revocation in flight is waited for and then
// seen (`recheck_inside_dispatch`). Each moved fact is refused with its own
// code, in `EFFECT_TIME_FACTS` order, and nothing is written. The order puts
// the cause before its consequence: a revocation and a supersession both end
// the lease too, and the answer names what moved first.
//
// **Only a replayable or reconcilable effect is dispatched.** Each effect
// operation declares its `reconcile_mode` by step kind; one that declares
// none is `neither`. No gate in this head accepts a duplicate, so `neither` is
// refused `EFFECT_NOT_RECONCILABLE` before any mark.
//
// **The mark.** The attempt's marker first, then the step naming it, because
// 0032's key onto the marked attempt is not deferrable. A second dispatch of a
// marked attempt writes nothing and answers the first mark, so a lost response
// is recovered by asking again. The answer carries no secret: the attempt
// identity is the effect's token (T2c2).

import type { Subject, TenantQuery } from '../../core-records/src/index.ts';
import { lockedInstant } from './clock.ts';
import {
  fenceCause,
  holdsLease,
  LEASE_FIXES,
  personWriteLive,
  readLease,
  refuseLease,
  type LeaseRow,
} from './lease-ownership.ts';
import { acquire, type LockRequest } from './locks.ts';
import { checkAuthorityAt, holdCoveringGrants } from './recovery.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

/** The facts rechecked at effect time, in the order a moved one is answered. */
export const EFFECT_TIME_FACTS = ['authority', 'approvedVersion', 'lease', 'budget'] as const;
export type EffectTimeFact = (typeof EFFECT_TIME_FACTS)[number];

export type ReconcileMode = 'replay' | 'observe' | 'neither';

/** Each effect operation's reconcile mode, by step kind. The synthetic note replays by token (O1). */
export const EFFECT_OPERATIONS: Readonly<Record<string, ReconcileMode>> = {
  synthetic_comment: 'replay',
};

interface DispatchCommon {
  readonly leaseId: string;
  readonly fence: number;
  /** The verified caller's actor, never a body field. */
  readonly holderActorId: string;
  readonly collection: string;
}

export type DispatchRequest =
  | (DispatchCommon & { readonly claimant: 'agent'; readonly delegationId: string })
  | (DispatchCommon & { readonly claimant: 'person'; readonly subjects: readonly Subject[] });

export interface Dispatched {
  readonly leaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly stepId: string;
  readonly stepKind: string;
  readonly reconcileMode: ReconcileMode;
  readonly dispatchedAt: Date;
}

const NOT_OWNED_FIX = 'Dispatch under the lease your own pickup was issued, at its fence.';

/** What discovery found behind the lease, before any lock. */
interface Found {
  readonly task_id: string;
  readonly step_id: string;
  readonly lineage_id: string;
  readonly gate_id: string;
  readonly reservation_id: string;
  readonly delegation_id: string | null;
  readonly delegate_person_id: string | null;
}

/** The facts as re-read under the locks. */
interface Facts {
  readonly approved: boolean;
  readonly covered: boolean;
  readonly delegation_revoked: boolean;
  readonly attempt_id: string;
  readonly step_kind: string;
  readonly dispatched_at: Date | null;
}

export async function dispatch(
  tx: TenantQuery,
  request: DispatchRequest,
): Promise<RuntimeResult<Dispatched>> {
  const found = await discover(tx, request.leaseId);
  if (found === undefined) return refuseLease('not_owned', NOT_OWNED_FIX);
  const subjects: readonly Subject[] =
    request.claimant === 'person'
      ? request.subjects
      : [{ kind: 'person', id: found.delegate_person_id ?? '' }];
  await holdCoveringGrants(tx, subjects, request.collection);
  const locks: LockRequest[] = [
    { lockClass: 'step', id: found.step_id },
    { lockClass: 'lineage', id: found.lineage_id },
    { lockClass: 'gate', id: found.gate_id },
    { lockClass: 'lease', id: request.leaseId },
    { lockClass: 'reservation', id: found.reservation_id },
  ];
  if (found.delegation_id !== null)
    locks.push({ lockClass: 'delegation', id: found.delegation_id });
  await acquire(tx, locks);

  const lockedAt = await lockedInstant(tx);
  const lease = await readLease(tx, request.leaseId, lockedAt);
  const caller =
    request.claimant === 'person'
      ? { claimant: 'person' as const, actorId: request.holderActorId }
      : {
          claimant: 'agent' as const,
          actorId: request.holderActorId,
          delegationId: request.delegationId,
        };
  if (lease === undefined || !holdsLease(lease, caller))
    return refuseLease('not_owned', NOT_OWNED_FIX);
  const fenced = fenceCause(lease, request.fence);
  if (fenced === 'fence_presented' || fenced === 'fence_superseded') {
    return refuseLease(fenced, NOT_OWNED_FIX);
  }

  const facts = await readFacts(tx, found, request.leaseId);
  for (const fact of EFFECT_TIME_FACTS) {
    // Sequential and in order: the first moved fact is the answer.
    // eslint-disable-next-line no-await-in-loop
    const moved = await recheck(fact, { tx, request, found, facts, lease, subjects, lockedAt });
    if (moved !== null) return moved;
  }

  const mode = Object.hasOwn(EFFECT_OPERATIONS, facts.step_kind)
    ? (EFFECT_OPERATIONS[facts.step_kind] as ReconcileMode)
    : 'neither';
  if (mode === 'neither') {
    return refuse(
      'EFFECT_NOT_RECONCILABLE',
      'this step declares an effect that can be neither replayed nor reconciled',
      'Nothing was dispatched. Declare how the effect replays or reconciles; no gate here accepts a duplicate.',
    );
  }
  const dispatchedAt = facts.dispatched_at ?? (await mark(tx, found, facts.attempt_id, lockedAt));
  return {
    ok: true,
    value: {
      leaseId: request.leaseId,
      taskId: found.task_id,
      attemptId: facts.attempt_id,
      stepId: found.step_id,
      stepKind: facts.step_kind,
      reconcileMode: mode,
      dispatchedAt,
    },
  };
}

/** Find: the lease and everything its dispatch touches, in this business only. */
async function discover(tx: TenantQuery, leaseId: string): Promise<Found | undefined> {
  const rows = await tx.query<Found>(
    `select l.task_id, att.step_id, run.lineage_id, g.id as gate_id, res.id as reservation_id,
            l.delegation_id, d.delegate_person_id
       from public.leases l
       join public.reservations res on res.business_id = l.business_id and res.id = l.reservation_id
       join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.gates g on g.business_id = res.business_id and g.version_id = res.version_id
       left join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.business_id = $1 and l.id = $2`,
    [tx.businessId, leaseId],
  );
  return rows[0];
}

/** Re-read, under the locks: the approval, the committed hold, and the step. */
async function readFacts(tx: TenantQuery, found: Found, leaseId: string): Promise<Facts> {
  const rows = await tx.query<Facts>(
    `select (g.state = 'approved' and ver.superseded_at is null and lin.state = 'live') as approved,
            (res.state = 'held' and res.lease_id = $3 and res.held_minor >= att.estimated_minor
              and att.state = 'dispatched' and att.lease_id = $3) as covered,
            coalesce(d.revoked_at is not null, false) as delegation_revoked,
            att.id as attempt_id, step.kind as step_kind, step.dispatched_at
       from public.reservations res
       join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
       join public.planned_steps step on step.business_id = att.business_id and step.id = att.step_id
       join public.proposal_versions ver on ver.business_id = res.business_id and ver.id = res.version_id
       join public.gates g on g.business_id = res.business_id and g.id = $4
       join public.proposal_lineages lin on lin.business_id = res.business_id and lin.id = $5
       left join public.delegations d on d.business_id = res.business_id and d.id = $6
      where res.business_id = $1 and res.id = $2`,
    [
      tx.businessId,
      found.reservation_id,
      leaseId,
      found.gate_id,
      found.lineage_id,
      found.delegation_id,
    ],
  );
  const facts = rows[0];
  if (facts === undefined) throw new Error('dispatch: the locked reservation could not be re-read');
  return facts;
}

interface Recheck {
  readonly tx: TenantQuery;
  readonly request: DispatchRequest;
  readonly found: Found;
  readonly facts: Facts;
  readonly lease: LeaseRow;
  readonly subjects: readonly Subject[];
  readonly lockedAt: string;
}

/** One fact, rechecked: `null` when it holds, its own refusal when it moved. */
async function recheck(fact: EffectTimeFact, on: Recheck): Promise<RuntimeResult<never> | null> {
  switch (fact) {
    case 'authority': {
      const task = { collection: on.request.collection, taskId: on.found.task_id };
      const live =
        !on.facts.delegation_revoked &&
        (on.request.claimant === 'person'
          ? await personWriteLive(
              on.tx,
              { subjects: on.subjects, collection: task.collection },
              task.taskId,
              on.lockedAt,
            )
          : (
              await checkAuthorityAt(
                on.tx,
                on.subjects,
                {
                  collection: task.collection,
                  action: 'write',
                  scope: { kind: 'record', id: task.taskId },
                },
                on.lockedAt,
              )
            ).ok);
      return live
        ? null
        : refuse(
            'AUTHORITY_LOST',
            'the authority behind this work is no longer live',
            'Nothing was dispatched. A person with write on this task has to authorise the work again.',
          );
    }
    case 'approvedVersion':
      return on.facts.approved
        ? null
        : refuse(
            'DECISION_STALE',
            'the approval behind this lease is no longer the current one',
            'Nothing was dispatched. Work the current approved version under a new pickup.',
          );
    case 'lease': {
      const cause = fenceCause(on.lease, on.request.fence);
      return cause === null ? null : refuseLease(cause, LEASE_FIXES.heartbeat.expired);
    }
    case 'budget':
      return on.facts.covered
        ? null
        : refuse(
            'BUDGET_UNAVAILABLE',
            'no committed reservation covers this attempt',
            'Nothing was dispatched. A reservation is committed when a person approves the work.',
          );
  }
}

/** The mark, in 0032's order: the attempt's marker, then the step naming it. */
async function mark(
  tx: TenantQuery,
  found: Found,
  attemptId: string,
  lockedAt: string,
): Promise<Date> {
  await tx.query(
    `update public.attempts set dispatch_marker = true
      where business_id = $1 and id = $2 and state = 'dispatched'`,
    [tx.businessId, attemptId],
  );
  const marked = await tx.query<{ readonly dispatched_at: Date }>(
    `update public.planned_steps
        set dispatched_at = $4::timestamptz, dispatch_attempt_id = $3, dispatch_marked = true
      where business_id = $1 and id = $2 and dispatched_at is null
      returning dispatched_at`,
    [tx.businessId, found.step_id, attemptId, lockedAt],
  );
  const at = marked[0]?.dispatched_at;
  if (at === undefined) throw new Error('dispatch: the locked step was not marked');
  return at;
}
