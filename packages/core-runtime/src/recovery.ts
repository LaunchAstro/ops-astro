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
import { revokeDelegation } from '../../core-records/src/authority/delegations.ts';
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
    readonly delegation_id: string | null;
    readonly delegation_revoked: boolean;
  }>(
    `select res.state, res.envelope_id, res.held_minor::text as held_minor,
            att.id as attempt_id, (att.dispatch_marker or att.observed) as marked,
            l.state as lease_state, lin.state as lineage_state, lin.id as lineage_id,
            (ver.superseded_at is not null) as superseded,
            l.delegation_id, coalesce(d.revoked_at is not null, false) as delegation_revoked
       from public.reservations res
       join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.proposal_lineages lin on lin.business_id = res.business_id and lin.id = run.lineage_id
       join public.proposal_versions ver on ver.business_id = res.business_id and ver.id = res.version_id
       left join public.leases l on l.business_id = res.business_id and l.id = res.lease_id
       left join public.delegations d on d.business_id = res.business_id and d.id = l.delegation_id
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
  // F4. The revocation this cause names is a delegation row, and the contract
  // locks it after the lease. Reading `revoked_at` as the fact means reading
  // it under that lock, not beside it.
  if (request.cause === 'authority_revoked' && row.delegation_id !== null) {
    locks.require('delegation', row.delegation_id);
  }

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
  readonly delegation_revoked: boolean;
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
      // F4. The durable fact is the revocation of the delegation this
      // attempt's lease was issued under. A grant revocation reaches here only
      // through the delegation it cost its authority, which `grant.revoke`
      // revokes in the same transaction, so one fact covers both.
      return row.delegation_revoked
        ? null
        : "no revocation is recorded on the delegation this attempt's lease was issued under";
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
  /** The delegation the hold's lease was issued under, which the contract locks after the lease. */
  readonly delegation_id: string | null;
  readonly cause: NonclaimableCause;
  readonly cause_id: string;
}

const AFFECTED_COLUMNS = `res.id as reservation_id, res.envelope_id, env.cap_id,
            run.task_id, run.id as run_id, lin.id as lineage_id, res.lease_id,
            held_lease.delegation_id`;

const AFFECTED_JOINS = `from public.reservations res
       join public.task_envelopes env on env.business_id = res.business_id and env.id = res.envelope_id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.proposal_lineages lin on lin.business_id = res.business_id and lin.id = run.lineage_id
       join public.proposal_versions ver on ver.business_id = res.business_id and ver.id = res.version_id
       left join public.leases held_lease
         on held_lease.business_id = res.business_id and held_lease.id = res.lease_id`;

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
    if (row.delegation_id !== null) {
      requests.push({ lockClass: 'delegation', id: row.delegation_id });
    }
  }
  return requests;
}

/**
 * R1. The same set means the same parents, not only the same reservation ids:
 * a reservation whose lease, run or envelope changed between discovery and the
 * locks is a reservation this transaction locked the wrong rows for.
 */
const SAME_SET = <T>(left: readonly T[], right: readonly T[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** A live lease on the work being closed, and the delegation it was issued under. */
interface LiveWork {
  readonly lease_id: string;
  readonly run_id: string;
  readonly delegation_id: string | null;
}

/**
 * Read-only: the live leases on a lineage's runs, or on the runs of a set of
 * versions. Cancellation and supersession both end the work these leases
 * authorise, so their leases and delegations belong to the lock set those
 * operations take, discovered here before any lock (F2, F3).
 */
export async function discoverLiveWork(
  tx: TenantQuery,
  target: { readonly lineageId: string } | { readonly versionIds: readonly string[] },
): Promise<readonly LiveWork[]> {
  const byLineage = 'lineageId' in target;
  return await tx.query<LiveWork>(
    `select l.id as lease_id, l.run_id, l.delegation_id
       from public.leases l
       join public.planned_runs run on run.business_id = l.business_id and run.id = l.run_id
      where l.business_id = $1 and l.state = 'live'
        and ${byLineage ? 'run.lineage_id = $2::uuid' : 'run.version_id = any($2::uuid[])'}
      order by l.id`,
    [tx.businessId, byLineage ? target.lineageId : target.versionIds],
  );
}

export function liveWorkLocks(work: readonly LiveWork[]): readonly LockRequest[] {
  return work.flatMap((row) => [
    { lockClass: 'run' as const, id: row.run_id },
    { lockClass: 'lease' as const, id: row.lease_id },
    ...(row.delegation_id === null
      ? []
      : [{ lockClass: 'delegation' as const, id: row.delegation_id }]),
  ]);
}

/**
 * End the work authority a transition has made obsolete: fence and release
 * each live lease, and revoke the delegation it was issued under. T5 names
 * both halves for cancellation ("releases the live lease and revokes the
 * delegation"); supersession retires the old version's work the same way, so
 * a holder of superseded work has nothing left to settle with (F3). Revoked
 * rather than settled: nothing was handed back, and the next call the agent
 * makes on that credential re-evaluates it and is refused.
 *
 * Under the caller's locks, which must include every row named here.
 */
export async function retireWork(
  tx: TenantQuery,
  work: readonly LiveWork[],
  locks: LockSet,
): Promise<void> {
  for (const row of work) {
    locks.require('lease', row.lease_id);
    if (row.delegation_id !== null) locks.require('delegation', row.delegation_id);
    // eslint-disable-next-line no-await-in-loop
    await tx.query(
      `update public.leases set state = 'released', released_at = now()
        where business_id = $1 and id = $2 and state = 'live'`,
      [tx.businessId, row.lease_id],
    );
    if (row.delegation_id !== null) {
      // eslint-disable-next-line no-await-in-loop
      await revokeDelegation(tx, row.delegation_id);
    }
  }
}

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
    // F4. A revocation that committed without its classification also left
    // its lease live, because the old handler wrote only the timestamp. The
    // lease and delegation are already in this set, so finishing the
    // transition here fences them rather than leaving an inert live claim on
    // the task until it expires.
    if (row.cause === 'authority_revoked' && row.lease_id !== null) {
      // eslint-disable-next-line no-await-in-loop
      await retireWork(
        tx,
        [{ lease_id: row.lease_id, run_id: row.run_id, delegation_id: row.delegation_id }],
        locks,
      );
    }
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
 * lineage is terminal, whose version is superseded, whose lease was fenced or
 * whose delegation was revoked. Each is a fact another authorised operation
 * wrote, and none is age, a missing claimant or a null lease.
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
                 when held_delegation.revoked_at is not null then 'authority_revoked'
                 else 'lease_expired_and_fenced' end as cause,
            case when lin.state in ('rejected', 'cancelled') then lin.id
                 when ver.superseded_at is not null then ver.id
                 when held_delegation.revoked_at is not null then held_delegation.id
                 else res.lease_id end as cause_id
       ${AFFECTED_JOINS}
       left join public.leases lease on lease.business_id = res.business_id and lease.id = res.lease_id
       left join public.delegations held_delegation
         on held_delegation.business_id = res.business_id
        and held_delegation.id = held_lease.delegation_id
      where res.business_id = $1
        and res.state = 'held'
        and ($2::uuid is null or lin.id = $2::uuid)
        and (lin.state in ('rejected', 'cancelled')
             or ver.superseded_at is not null
             -- F4. A revocation that committed without its classification:
             -- the delegation row records it, and the lease may still be live.
             or held_delegation.revoked_at is not null
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
 * lineage, fence and release the live lease, revoke the delegation it was
 * issued under, end its runs as cancelled (F2), then classify **its own**
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
  const terminal = refuse(
    'LINEAGE_TERMINAL',
    `lineage ${request.lineageId} is not live, so there is nothing to cancel`,
    'Read its terminal reason. Cancelling twice is not a second cancellation.',
  );
  const live = await tx.query<{ readonly state: string }>(
    `select state from public.proposal_lineages where business_id = $1 and id = $2`,
    [tx.businessId, request.lineageId],
  );
  if (live[0]?.state !== 'live') return terminal;

  // Discovery before the locks: every reservation this lineage owns, whatever
  // its version's own state, because cancellation makes all of them
  // nonclaimable; and (F2) every live lease on its runs with the delegation it
  // was issued under, because cancellation ends that authority too.
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
  const workBefore = await discoverLiveWork(tx, { lineageId: request.lineageId });
  const locks = await acquire(tx, [
    ...locksFor(before),
    ...liveWorkLocks(workBefore),
    { lockClass: 'lineage', id: request.lineageId },
  ]);

  // Rechecked under the locks and before the first write: a set that moved
  // means this transaction holds the wrong rows, and it rolls back rather
  // than extending its locks backwards.
  const after = await discover();
  const workAfter = await discoverLiveWork(tx, { lineageId: request.lineageId });
  if (!SAME_SET(before, after) || !SAME_SET(workBefore, workAfter)) {
    throw new Error(
      'cancellation: the affected set changed under discovery; roll back and rediscover rather than extending the lock set',
    );
  }

  const updated = await tx.query<{ readonly id: string }>(
    `update public.proposal_lineages
        set state = 'cancelled', terminal_reason = $3, terminal_at = now()
      where business_id = $1 and id = $2 and state = 'live'
      returning id`,
    [tx.businessId, request.lineageId, request.reason],
  );
  if (updated[0] === undefined) return terminal;

  await retireWork(tx, workAfter, locks);
  // Nothing in this head dispatches, so the ordinary cancellation completes as
  // cancelled (T5). A run already handed back keeps that outcome as history.
  await tx.query(
    `update public.planned_runs set state = 'cancelled'
      where business_id = $1 and lineage_id = $2 and state in ('planned', 'claimed')`,
    [tx.businessId, request.lineageId],
  );

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

/** What a revocation wrote under the locks, and whose work authority it cost. */
export type RevocationWrite<T> =
  | { readonly applied: false; readonly value: T }
  | { readonly applied: true; readonly value: T; readonly lost: readonly string[] };

export interface AuthorityLoss<T> {
  readonly value: T;
  readonly applied: boolean;
  readonly classified: readonly Classification[];
}

/**
 * F4. Recorded authority loss, as an owning transition: `delegation.revoke`
 * and `grant.revoke` both end here.
 *
 * `delegationIds` is every delegation the revocation might cost its work
 * authority, discovered by the caller before any lock. This discovers the live
 * leases issued under them and the holds bound to those leases, takes the
 * complete set (cap, envelope, task, run, lineage, lease, delegation,
 * reservation) in `LOCK_ORDER`, and re-reads it. Only then does `revoke` run:
 * it writes the revocation itself and names, from what it re-read under the
 * locks, the delegations that actually lost authority. Each of those is
 * revoked, its live lease released and fenced, and its holds classified as
 * `authority_revoked` with the delegation as the recorded cause.
 *
 * A marked or observed attempt is quarantined by the classifier with its full
 * hold, exactly as it is under every other cause.
 */
export async function classifyAuthorityLoss<T>(
  tx: TenantQuery,
  request: {
    readonly delegationIds: readonly string[];
    readonly revoke: (locks: LockSet) => Promise<RevocationWrite<T>>;
  },
): Promise<AuthorityLoss<T>> {
  const ids = [...new Set(request.delegationIds)].toSorted();
  const discoverWork = async (): Promise<readonly LiveWork[]> =>
    await tx.query<LiveWork>(
      `select l.id as lease_id, l.run_id, l.delegation_id
         from public.leases l
        where l.business_id = $1 and l.state = 'live' and l.delegation_id = any($2::uuid[])
        order by l.id`,
      [tx.businessId, ids],
    );
  const discoverHeld = async (): Promise<readonly Affected[]> =>
    await tx.query<Affected>(
      `select ${AFFECTED_COLUMNS}, 'authority_revoked' as cause,
              held_lease.delegation_id as cause_id
         ${AFFECTED_JOINS}
        where res.business_id = $1 and res.state = 'held'
          and held_lease.state = 'live' and held_lease.delegation_id = any($2::uuid[])
        order by res.id`,
      [tx.businessId, ids],
    );

  const workBefore = await discoverWork();
  const heldBefore = await discoverHeld();
  const locks = await acquire(tx, [
    ...locksFor(heldBefore),
    ...liveWorkLocks(workBefore),
    // A delegation with no live lease is still the row being revoked.
    ...ids.map((id) => ({ lockClass: 'delegation' as const, id })),
  ]);
  const workAfter = await discoverWork();
  const heldAfter = await discoverHeld();
  if (!SAME_SET(workBefore, workAfter) || !SAME_SET(heldBefore, heldAfter)) {
    throw new Error(
      'authority loss: the affected set changed under discovery; roll back and rediscover rather than extending the lock set',
    );
  }

  const written = await request.revoke(locks);
  if (!written.applied) return { value: written.value, applied: false, classified: [] };

  const lost = new Set(written.lost);
  const classified: Classification[] = [];
  for (const id of ids.filter((each) => lost.has(each))) {
    locks.require('delegation', id);
    // Revoked here as well as by `delegation.revoke`'s own write, because a
    // grant revocation costs the delegation its authority without touching
    // its row, and the classifier's fact is that row's `revoked_at`.
    // eslint-disable-next-line no-await-in-loop
    await revokeDelegation(tx, id);
    // eslint-disable-next-line no-await-in-loop
    await retireWork(
      tx,
      workAfter.filter((row) => row.delegation_id === id),
      locks,
    );
    for (const row of heldAfter.filter((each) => each.delegation_id === id)) {
      // eslint-disable-next-line no-await-in-loop
      const one = await classifyUnderLocks(
        tx,
        { reservationId: row.reservation_id, cause: 'authority_revoked', causeId: id },
        locks,
      );
      classified.push(one);
    }
  }
  return { value: written.value, applied: true, classified };
}
