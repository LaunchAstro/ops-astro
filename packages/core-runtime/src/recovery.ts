// SPDX-License-Identifier: AGPL-3.0-only
//
// T5: the bounded unstarted-attempt classifier.
//
// What it is not is most of the definition. It is not a worker, not a general
// sweeper, not a top-up, not a write-off and not an effect activation. It is
// invoked from inside the authorised operations that create the durable
// transitions it reads — completed handback, cancellation, rejection or
// supersession, recorded authority loss, and the fencing of an expired lease —
// and `classifyUnderLocks` takes no lock of its own, because its caller is
// holding the complete set already.
//
// **Eligibility is a recorded cause, never a clock.** Startup, elapsed time
// without an accepted expiry, a missing claimant and `lease_id = null` are all
// explicitly not abandonment triggers (T5). An approved, unleased, currently
// authorised reservation stays held across a crash and remains pickupable;
// that case is the one the whole classifier exists to leave alone.
//
// **A marker or an observation always retains the full hold.** Even when the
// work is otherwise terminal, a dispatch marker or an observation means
// something happened that this head has no reachable path to, so the hold is
// quarantined and named for a later reconciliation owner. Work refusal must
// never erase a real liability.

import type { TenantQuery } from '../../core-records/src/tenancy/database.ts';
import { acquire, type LockRequest, type LockSet } from './locks.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

/** The durable causes that make an exact attempt nonclaimable. Nothing else is one. */
export type NonclaimableCause =
  | 'handback_completed'
  | 'lineage_rejected'
  | 'lineage_cancelled'
  | 'version_superseded'
  | 'authority_revoked'
  | 'lease_expired_and_fenced';

export interface Classification {
  readonly reservationId: string;
  readonly released: boolean;
  readonly state: 'abandoned' | 'held' | 'quarantined';
  /** Why it was left alone, when it was. A classification with no reason is a guess. */
  readonly reason: string;
}

export interface ClassifyRequest {
  readonly reservationId: string;
  readonly cause: NonclaimableCause;
  /** The identity of the transition that established the cause, recorded on the row. */
  readonly causeId: string;
}

/**
 * The classifier proper. Its caller holds cap, envelope, task, run, lineage,
 * lease and reservation; this takes none of them, and it re-reads under them.
 *
 * R1. `locks` is required, not advisory. The reviewer's case was two
 * classifiers both reading `held`, both updating an attempt and both
 * subtracting one hold from one envelope, which the non-negative constraint
 * catches only when the second subtraction drives the total below zero. A
 * helper that asserts its caller's locks cannot be the second of those two,
 * and `LockSet.require` throws rather than refuses because a caller reaching
 * outside its lock set is a bug in that caller, not an answer about authority.
 */
export async function classifyUnderLocks(
  tx: TenantQuery,
  request: ClassifyRequest,
  locks: LockSet,
): Promise<Classification> {
  locks.require('reservation', request.reservationId);

  const rows = await tx.query<{
    readonly state: string;
    readonly envelope_id: string;
    readonly held_minor: string;
    readonly attempt_id: string;
    readonly marked: boolean;
    readonly lease_state: string | null;
    readonly lineage_state: string;
    readonly lineage_id: string;
    readonly superseded: boolean;
  }>(
    `select res.state, res.envelope_id, res.held_minor::text as held_minor,
            att.id as attempt_id, (att.dispatch_marker or att.observed) as marked,
            l.state as lease_state, lin.state as lineage_state, lin.id as lineage_id,
            (ver.superseded_at is not null) as superseded
       from public.reservations res
       join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.proposal_lineages lin on lin.business_id = res.business_id and lin.id = run.lineage_id
       join public.proposal_versions ver on ver.business_id = res.business_id and ver.id = res.version_id
       left join public.leases l on l.business_id = res.business_id and l.id = res.lease_id
      where res.business_id = $1 and res.id = $2`,
    [tx.businessId, request.reservationId],
  );
  const row = rows[0];
  if (row === undefined) {
    return {
      reservationId: request.reservationId,
      released: false,
      state: 'held',
      reason: 'no such reservation in this business',
    };
  }

  // Idempotent. A terminal row classified again is the same answer, which is
  // what makes restart replay exactly-once rather than twice.
  if (row.state !== 'held') {
    return {
      reservationId: request.reservationId,
      released: false,
      state: row.state === 'quarantined' ? 'quarantined' : 'abandoned',
      reason: `already ${row.state}; a terminal reservation is never reclassified or revived`,
    };
  }

  // The envelope's total is about to move, so its lock belongs to the caller's
  // set as well. Discovering it here and taking it here would be the late
  // envelope lock the contract forbids.
  locks.require('envelope', row.envelope_id);

  if (row.marked) {
    await tx.query(
      `update public.reservations set state = 'quarantined' where business_id = $1 and id = $2`,
      [tx.businessId, request.reservationId],
    );
    await tx.query(
      `update public.attempts set state = 'quarantined', outcome = coalesce(outcome, 'unknown')
        where business_id = $1 and id = $2`,
      [tx.businessId, row.attempt_id],
    );
    return {
      reservationId: request.reservationId,
      released: false,
      state: 'quarantined',
      reason:
        'the attempt carries a dispatch marker or an observation; the full hold is retained as unknown for the recorded reconciliation owner',
    };
  }

  // R1. The cause is revalidated against the durable rows under these locks,
  // rather than believed because the caller named it. A cause string that no
  // row supports is not a transition; it is a request to release a claimable
  // hold, and T5's whole point is that no such request is honoured.
  const supported = supportsCause(request.cause, row);
  if (supported !== null) {
    return {
      reservationId: request.reservationId,
      released: false,
      state: 'held',
      reason: supported,
    };
  }

  // R1. The guarded update reports the row it actually changed, and everything
  // after it is conditional on that row. A classifier whose conditional update
  // affected nothing has lost the race, and it must not then move the attempt
  // or subtract a hold the winner has already subtracted.
  const changed = await tx.query<{ readonly held_minor: string }>(
    `update public.reservations
        set state = 'abandoned', classified_cause = $3, classified_cause_id = $4, terminal_at = now()
      where business_id = $1 and id = $2 and state = 'held'
      returning held_minor::text as held_minor`,
    [tx.businessId, request.reservationId, request.cause, request.causeId],
  );
  const released = changed[0];
  if (released === undefined) {
    return {
      reservationId: request.reservationId,
      released: false,
      state: 'abandoned',
      reason: 'another transaction classified this reservation first; the hold was released once',
    };
  }
  await tx.query(
    `update public.attempts set state = 'abandoned', outcome = coalesce(outcome, 'abandoned')
      where business_id = $1 and id = $2`,
    [tx.businessId, row.attempt_id],
  );
  // Subtracted once, from the held total only, and by the amount the changed
  // row carried. Nothing is added to `actual`: there is no observation to
  // justify a number, not even zero.
  await tx.query(
    `update public.task_envelopes set held_minor = held_minor - $3
      where business_id = $1 and id = $2`,
    [tx.businessId, row.envelope_id, Number(released.held_minor)],
  );

  return {
    reservationId: request.reservationId,
    released: true,
    state: 'abandoned',
    reason: `abandoned under ${request.cause} (${request.causeId}); the hold was released once and no cost was recorded`,
  };
}

interface CauseRow {
  readonly lease_state: string | null;
  readonly lineage_state: string;
  readonly superseded: boolean;
}

/**
 * Does a durable row support the cause the caller named? Returns `null` when
 * it does, and the reason it does not otherwise, so the classifier's refusal
 * says which fact was missing rather than "not eligible".
 */
function supportsCause(cause: NonclaimableCause, row: CauseRow): string | null {
  switch (cause) {
    case 'lease_expired_and_fenced':
      // The one place elapsed time appears, and even there it is the caller's
      // fencing transition, not a deadline this module invented.
      return row.lease_state === 'live'
        ? 'the lease is still live, so this attempt is still claimable'
        : null;
    case 'handback_completed':
      return row.lease_state === null || row.lease_state === 'live'
        ? 'no settled lease records a completed handback for this attempt'
        : null;
    case 'lineage_cancelled':
      return row.lineage_state === 'cancelled'
        ? null
        : `the lineage is ${row.lineage_state}, not cancelled`;
    case 'lineage_rejected':
      return row.lineage_state === 'rejected'
        ? null
        : `the lineage is ${row.lineage_state}, not rejected`;
    case 'version_superseded':
      return row.superseded ? null : "this attempt's version is still the live one";
    case 'authority_revoked':
      // The revocation lives in L2's grant and delegation rows, which the
      // owning operation has already re-read under these same locks.
      return null;
  }
}

/** Every row the classifier will touch for one reservation, discovered before the locks. */
interface Affected {
  readonly reservation_id: string;
  readonly envelope_id: string;
  readonly cap_id: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly lineage_id: string;
  readonly lease_id: string | null;
  readonly cause: NonclaimableCause;
  readonly cause_id: string;
}

const AFFECTED_COLUMNS = `res.id as reservation_id, res.envelope_id, env.cap_id,
            run.task_id, run.id as run_id, lin.id as lineage_id, res.lease_id`;

const AFFECTED_JOINS = `from public.reservations res
       join public.task_envelopes env on env.business_id = res.business_id and env.id = res.envelope_id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.proposal_lineages lin on lin.business_id = res.business_id and lin.id = run.lineage_id
       join public.proposal_versions ver on ver.business_id = res.business_id and ver.id = res.version_id`;

/** The complete lock set for a discovered affected set, in `LOCK_ORDER`. `acquire` sorts it. */
function locksFor(affected: readonly Affected[]): readonly LockRequest[] {
  const requests: LockRequest[] = [];
  for (const row of affected) {
    requests.push(
      { lockClass: 'cap', id: row.cap_id },
      { lockClass: 'envelope', id: row.envelope_id },
      { lockClass: 'task', id: row.task_id },
      { lockClass: 'run', id: row.run_id },
      { lockClass: 'lineage', id: row.lineage_id },
      { lockClass: 'reservation', id: row.reservation_id },
    );
    if (row.lease_id !== null) requests.push({ lockClass: 'lease', id: row.lease_id });
  }
  return requests;
}

const SAME_SET = (left: readonly Affected[], right: readonly Affected[]): boolean =>
  left.length === right.length &&
  left.every((row, index) => row.reservation_id === right[index]?.reservation_id);

/**
 * Discover, lock, rediscover, classify. The rediscovery is the contract's
 * restart rule in one function: if the affected set changed between the
 * unlocked discovery and the locks, this transaction has the wrong lock set
 * and must not write under it.
 */
async function lockAndClassify(
  tx: TenantQuery,
  discover: () => Promise<readonly Affected[]>,
  extraLocks: readonly LockRequest[] = [],
): Promise<readonly Classification[]> {
  const before = await discover();
  const locks = await acquire(tx, [...locksFor(before), ...extraLocks]);
  const after = await discover();
  if (!SAME_SET(before, after)) {
    throw new Error(
      'recovery: the affected set changed under discovery; roll back and rediscover rather than extending the lock set',
    );
  }

  const classified: Classification[] = [];
  for (const row of after) {
    // One at a time, inside the caller's transaction. Running these in
    // parallel would interleave their reads of the same envelope totals.
    // eslint-disable-next-line no-await-in-loop
    const one = await classifyUnderLocks(
      tx,
      { reservationId: row.reservation_id, cause: row.cause, causeId: row.cause_id },
      locks,
    );
    classified.push(one);
  }
  return classified;
}

/**
 * Restart replay. It finds reservations whose **recorded** transition already
 * made them nonclaimable and whose classification did not commit, and runs the
 * same classifier over them under the complete ordered lock set (R1).
 *
 * It manufactures no eligibility. The query below asks only about rows whose
 * lineage is terminal or whose version is superseded — facts another
 * authorised operation wrote — and never about age, a missing claimant or a
 * null lease.
 */
export async function replayRecordedTransitions(
  tx: TenantQuery,
): Promise<readonly Classification[]> {
  return await lockAndClassify(tx, async () => discoverEligible(tx, null));
}

/** The eligible set, business-wide or scoped to one lineage. Read-only; acquires nothing. */
async function discoverEligible(
  tx: TenantQuery,
  lineageId: string | null,
): Promise<readonly Affected[]> {
  const rows = await tx.query<Affected>(
    `select ${AFFECTED_COLUMNS},
            case when lin.state in ('rejected', 'cancelled') then 'lineage_' || lin.state
                 when ver.superseded_at is not null then 'version_superseded'
                 else 'lease_expired_and_fenced' end as cause,
            case when lin.state in ('rejected', 'cancelled') then lin.id
                 when ver.superseded_at is not null then ver.id
                 else res.lease_id end as cause_id
       ${AFFECTED_JOINS}
       left join public.leases lease on lease.business_id = res.business_id and lease.id = res.lease_id
      where res.business_id = $1
        and res.state = 'held'
        and ($2::uuid is null or lin.id = $2::uuid)
        and (lin.state in ('rejected', 'cancelled')
             or ver.superseded_at is not null
             -- R5. A hold still bound to a lease the server has already fenced
             -- has a recorded transition and no classification, which is the
             -- exactly-once case W04 asks recovery to finish. It is still not
             -- a clock: the lease's own terminal state is the fact, and a live
             -- lease -- expired by its timestamp or not -- is not in this set.
             or lease.state in ('expired', 'released'))
      order by res.id`,
    [tx.businessId, lineageId],
  );
  return rows;
}

/**
 * The holds one transition made nonclaimable, classified inside the same
 * transaction that recorded it (R8). Supersession and rejection call this
 * rather than leaving the old hold for an unrelated replay: an approval of
 * version 2 that fails for room version 1 is no longer entitled to is the
 * wrong answer, and "run the business-wide replay from cancellation" was the
 * wrong ownership dependency.
 *
 * The caller has already acquired these rows. `locks` is required for the same
 * reason the classifier's is.
 */
export async function classifyVersions(
  tx: TenantQuery,
  versionIds: readonly string[],
  cause: NonclaimableCause,
  causeId: string,
  locks: LockSet,
): Promise<readonly Classification[]> {
  if (versionIds.length === 0) return [];
  const rows = await tx.query<{ readonly id: string }>(
    `select id from public.reservations
      where business_id = $1 and state = 'held' and version_id = any($2::uuid[])
      order by id`,
    [tx.businessId, versionIds],
  );
  const classified: Classification[] = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const one = await classifyUnderLocks(tx, { reservationId: row.id, cause, causeId }, locks);
    classified.push(one);
  }
  return classified;
}

/** Read-only: the reservations a set of versions still holds, with their parents. */
export async function affectedByVersions(
  tx: TenantQuery,
  versionIds: readonly string[],
): Promise<readonly LockRequest[]> {
  if (versionIds.length === 0) return [];
  const rows = await tx.query<Affected>(
    `select ${AFFECTED_COLUMNS}, 'version_superseded' as cause, ver.id as cause_id
       ${AFFECTED_JOINS}
      where res.business_id = $1 and res.state = 'held' and res.version_id = any($2::uuid[])
      order by res.id`,
    [tx.businessId, versionIds],
  );
  return locksFor(rows);
}

/**
 * The cancellation path's entry point: record the person's cancellation on the
 * lineage, fence and release the live lease, then classify **its own**
 * reservations. Exported because T5 names cancellation as one of the owning
 * transitions, and L3 wires it.
 *
 * R1. Everything is discovered and locked before the first write, and the
 * classification is scoped to this lineage. The old shape updated the lineage,
 * then the leases, then reached the envelope through the classifier — a
 * cancellation holding the lineage waiting on an envelope a handback already
 * held — and then classified every eligible lineage in the business rather
 * than the one it was asked about.
 */
export async function cancelAndClassify(
  tx: TenantQuery,
  request: { readonly lineageId: string; readonly reason: string },
): Promise<RuntimeResult<readonly Classification[]>> {
  const live = await tx.query<{ readonly state: string }>(
    `select state from public.proposal_lineages where business_id = $1 and id = $2`,
    [tx.businessId, request.lineageId],
  );
  if (live[0]?.state !== 'live') {
    return refuse(
      'LINEAGE_TERMINAL',
      `lineage ${request.lineageId} is not live, so there is nothing to cancel`,
      'Read its terminal reason. Cancelling twice is not a second cancellation.',
    );
  }

  // Discovery before the locks: every reservation this lineage owns, whatever
  // its version's own state, because cancellation makes all of them
  // nonclaimable and all of their parents are in this transaction's set.
  const discover = async (): Promise<readonly Affected[]> => {
    const rows = await tx.query<Affected>(
      `select ${AFFECTED_COLUMNS}, 'lineage_cancelled' as cause, lin.id as cause_id
         ${AFFECTED_JOINS}
        where res.business_id = $1 and res.state = 'held' and lin.id = $2
        order by res.id`,
      [tx.businessId, request.lineageId],
    );
    return rows;
  };

  const before = await discover();
  const locks = await acquire(tx, [
    ...locksFor(before),
    { lockClass: 'lineage', id: request.lineageId },
  ]);

  const updated = await tx.query<{ readonly id: string }>(
    `update public.proposal_lineages
        set state = 'cancelled', terminal_reason = $3, terminal_at = now()
      where business_id = $1 and id = $2 and state = 'live'
      returning id`,
    [tx.businessId, request.lineageId, request.reason],
  );
  if (updated[0] === undefined) {
    return refuse(
      'LINEAGE_TERMINAL',
      `lineage ${request.lineageId} is not live, so there is nothing to cancel`,
      'Read its terminal reason. Cancelling twice is not a second cancellation.',
    );
  }
  await tx.query(
    `update public.leases set state = 'released', released_at = now()
      where business_id = $1 and state = 'live'
        and run_id in (select id from public.planned_runs
                        where business_id = $1 and lineage_id = $2)`,
    [tx.businessId, request.lineageId],
  );

  const after = await discover();
  if (!SAME_SET(before, after)) {
    throw new Error(
      'cancellation: the affected set changed under discovery; roll back and rediscover rather than extending the lock set',
    );
  }

  const classified: Classification[] = [];
  for (const row of after) {
    // eslint-disable-next-line no-await-in-loop
    const one = await classifyUnderLocks(
      tx,
      { reservationId: row.reservation_id, cause: 'lineage_cancelled', causeId: row.cause_id },
      locks,
    );
    classified.push(one);
  }
  return { ok: true, value: classified };
}
