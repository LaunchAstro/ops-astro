// SPDX-License-Identifier: AGPL-3.0-only
//
// T2c2: the lease holder observes the one effect its dispatch let it apply.
//
// The token is the attempt the dispatch answered, presented with the lease and
// its fence. Anything else is the lease refusal a fabricated one gets. Expiry
// is not a refusal here: an effect applied before the lease ran out still
// happened, and settlement reads its observation (T2d).
//
// **Did it happen?** The operation register answers, never the caller: the
// command layer hands in the applied effect it found under the attempt's
// derived identity (`effectOperationId`), or nothing. A dispatched attempt
// with no applied effect is a staged intent, and is refused
// `EFFECT_NOT_OBSERVED`, unless the worker reports it failed. An attempt whose
// hold was released is refused `BUDGET_UNAVAILABLE`. Neither writes.
//
// T2d: the worker reports usage, and observe settles the hold at its priced
// cost (`price-book.ts`, `budget.ts`). A failed attempt settles too, and counts
// against the ceiling. An unpriced or absent report settles nothing. A cost
// above the hold keeps the whole hold as `liability_unknown`. Observing a
// settled attempt answers its settlement and charges nothing more.

import type { TenantQuery } from '../../core-records/src/index.ts';
import { lockedInstant } from './clock.ts';
import { fenceCause, holdsLease, readLease, refuseLease } from './lease-ownership.ts';
import { acquire } from './locks.ts';
import { settleAtObserved, settledAt, type Settlement } from './budget.ts';
import { priceAttempt } from './price-book.ts';
import { refuse, type RuntimeResult } from './refusals.ts';
import type { DispatchRequest } from './dispatch.ts';

/** The effect the operation register holds under the attempt's derived identity. */
export interface AppliedEffect {
  readonly operationId: string;
  readonly taskId: string;
  readonly commentId: string;
}

export type ObserveRequest = DispatchRequest & {
  readonly attemptId: string;
  /** Asked under the locks, so an effect committing meanwhile is seen (Sol review 2 on #124). */
  readonly effect: () => Promise<AppliedEffect | undefined>;
  /** What the step used, as the worker's reporter says it; the book prices it. */
  readonly usage: unknown;
  /** The worker's word that the step failed: settles its cost with no effect. */
  readonly outcome: 'completed' | 'failed';
};

export interface Observed {
  readonly leaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly effect: { readonly operationId: string; readonly commentId: string } | null;
  readonly settlement: Settlement;
}

const NOT_OWNED_FIX = 'Observe under the lease your own pickup was issued, with its attempt.';

interface Found {
  readonly task_id: string;
  readonly step_id: string;
  readonly reservation_id: string;
  readonly attempt_id: string;
  readonly delegation_id: string | null;
}

export async function observe(
  tx: TenantQuery,
  request: ObserveRequest,
): Promise<RuntimeResult<Observed>> {
  const found = await discover(tx, request.leaseId);
  const presented = request.claimant === 'agent' ? request.delegationId : null;
  if (
    found === undefined ||
    found.delegation_id !== presented ||
    found.attempt_id !== request.attemptId
  ) {
    return refuseLease('not_owned', NOT_OWNED_FIX);
  }
  const owned = await ownedUnderLocks(tx, request, found);
  if (owned !== null) return owned;
  const state = await heldState(tx, found.attempt_id, request.leaseId);
  if (!state.held) {
    return refuse(
      'BUDGET_UNAVAILABLE',
      'no committed hold covers this attempt any more',
      'Nothing was observed and no money moved. A released hold is settled by its classifier.',
    );
  }
  const effect = await request.effect();
  const applied = state.marked && effect !== undefined && effect.taskId === found.task_id;
  const failed = state.marked && effect === undefined && request.outcome === 'failed';
  if (!applied && !failed) {
    return refuse(
      'EFFECT_NOT_OBSERVED',
      'the operation register holds no applied effect for this attempt',
      'Nothing was observed. Apply the effect under its attempt’s operation identity, then observe it.',
    );
  }
  if (state.attempt_state === 'liability_unknown') {
    return refuse(
      'BUDGET_UNAVAILABLE',
      'this attempt reported more than its hold and is held as an unknown liability',
      'Nothing was settled. A person records this attempt’s outcome.',
    );
  }
  if (applied && !state.observed) {
    await tx.query(
      `update public.attempts set observed = true
        where business_id = $1 and id = $2 and dispatch_marker`,
      [tx.businessId, found.attempt_id],
    );
  }
  return {
    ok: true,
    value: {
      leaseId: request.leaseId,
      taskId: found.task_id,
      attemptId: found.attempt_id,
      effect: applied ? { operationId: effect.operationId, commentId: effect.commentId } : null,
      settlement: await settlementOf(tx, found, state, request, applied ? 'completed' : 'failed'),
    },
  };
}

/** The attempt's settlement: the one already made, or one made now at the priced cost. */
async function settlementOf(
  tx: TenantQuery,
  found: Found,
  state: HeldState,
  request: ObserveRequest,
  outcome: 'completed' | 'failed',
): Promise<Settlement> {
  const heldMinor = BigInt(state.held_minor);
  if (state.attempt_state === 'settled')
    return settledAt(heldMinor, BigInt(state.actual_minor ?? 0));
  const cost = priceAttempt(
    { priceBook: state.price_book, currency: state.currency },
    request.usage,
  );
  if (cost === undefined) return { state: 'unpriced', heldMinor: Number(heldMinor) };
  return await settleAtObserved(tx, {
    attemptId: found.attempt_id,
    reservationId: found.reservation_id,
    envelopeId: state.envelope_id,
    heldMinor,
    costMinor: cost,
    outcome,
  });
}

/** Where the lease leads, in this business only, before any lock. */
async function discover(tx: TenantQuery, leaseId: string): Promise<Found | undefined> {
  const rows = await tx.query<Found>(
    `select l.task_id, att.step_id, res.id as reservation_id, att.id as attempt_id, l.delegation_id
       from public.leases l
       join public.reservations res on res.business_id = l.business_id and res.id = l.reservation_id
       join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
      where l.business_id = $1 and l.id = $2`,
    [tx.businessId, leaseId],
  );
  return rows[0];
}

/** The lease locked and read as the caller's at its own fence: `null`, or the refusal. */
async function ownedUnderLocks(
  tx: TenantQuery,
  request: ObserveRequest,
  found: Found,
): Promise<RuntimeResult<never> | null> {
  await acquire(tx, [
    { lockClass: 'step', id: found.step_id },
    { lockClass: 'lease', id: request.leaseId },
    { lockClass: 'reservation', id: found.reservation_id },
  ]);
  const lease = await readLease(tx, request.leaseId, await lockedInstant(tx));
  const caller =
    request.claimant === 'person'
      ? { claimant: 'person' as const, actorId: request.holderActorId }
      : {
          claimant: 'agent' as const,
          actorId: request.holderActorId,
          delegationId: request.delegationId,
        };
  if (lease === undefined || !holdsLease(lease, caller)) {
    return refuseLease('not_owned', NOT_OWNED_FIX);
  }
  const fenced = fenceCause(lease, request.fence);
  if (fenced === 'fence_presented' || fenced === 'fence_superseded') {
    return refuseLease(fenced, NOT_OWNED_FIX);
  }
  return null;
}

interface HeldState {
  readonly held: boolean;
  readonly marked: boolean;
  readonly observed: boolean;
  readonly attempt_state: string;
  readonly held_minor: string;
  readonly actual_minor: string | null;
  readonly price_book: string;
  readonly envelope_id: string;
  readonly currency: string;
}

/** The hold, the markers and what settlement reads, re-read under the locks. */
async function heldState(tx: TenantQuery, attemptId: string, leaseId: string): Promise<HeldState> {
  const state = (
    await tx.query<HeldState>(
      `select (res.lease_id = $3 and (res.state = 'held' or att.state = 'settled')) as held,
              att.dispatch_marker as marked, att.observed, att.state as attempt_state,
              res.held_minor::text as held_minor, att.actual_minor::text as actual_minor,
              att.price_book, att.envelope_id, env.currency
         from public.attempts att
         join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
         join public.task_envelopes env on env.business_id = att.business_id and env.id = att.envelope_id
        where att.business_id = $1 and att.id = $2`,
      [tx.businessId, attemptId, leaseId],
    )
  )[0];
  if (state === undefined) throw new Error('observe: the locked attempt could not be re-read');
  return state;
}
