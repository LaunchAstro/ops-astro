// SPDX-License-Identifier: AGPL-3.0-only
//
// T5: the bounded unstarted-attempt classifier, the reads that find what it
// classifies, and the grant reads every owning transaction shares. The rules
// it keeps are in `../recovery.ts`, the module's one surface.

import { checkAuthority, refuseCommand } from '../../../core-records/src/index.ts';
import type {
  TenantQuery,
  Decision,
  EffectiveGrant,
  ScopeRequest,
  Subject,
} from '../../../core-records/src/index.ts';
import type { LockRequest, LockSet } from '../locks.ts';

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
 * R1. `locks` is required, not advisory. The race it closes is two
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
  // The revocation this cause names is a delegation row, and the contract
  // locks it after the lease. Reading `revoked_at` as the fact means reading
  // it under that lock, not beside it.
  if (request.cause === 'authority_revoked' && row.delegation_id !== null) {
    locks.require('delegation', row.delegation_id);
  }
  // EX-01. A person's own lease has no delegation to carry the revocation, so
  // its recorded fact is the revoked grant the cause names, read here like the
  // rest. The grant row is locked by `grant.revoke` before any runtime lock.
  const grantRevoked =
    request.cause === 'authority_revoked' && row.delegation_id === null
      ? (
          await tx.query<{ readonly revoked: boolean }>(
            `select (revoked_at is not null) as revoked from public.grants
              where business_id = $1 and id = $2::uuid`,
            [tx.businessId, request.causeId],
          )
        )[0]?.revoked === true
      : false;

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
  const supported = supportsCause(request.cause, { ...row, grant_revoked: grantRevoked });
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
  /** For a lease with no delegation: whether the grant the cause names is revoked. */
  readonly grant_revoked: boolean;
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
      // The durable fact is the revocation of the delegation this
      // attempt's lease was issued under. A grant revocation reaches here only
      // through the delegation it cost its authority, which `grant.revoke`
      // revokes in the same transaction, so one fact covers both.
      if (row.delegation_revoked) return null;
      // EX-01. A person's own lease: the grant revoked and the lease no longer
      // live, which `classifyAuthorityLoss` writes in one transaction.
      if (row.grant_revoked && row.lease_state !== null && row.lease_state !== 'live') return null;
      return "no revocation is recorded on the delegation or grant this attempt's work drew on";
  }
}

/** Every row the classifier will touch for one reservation, discovered before the locks. */
export interface Affected {
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

export const AFFECTED_COLUMNS = `res.id as reservation_id, res.envelope_id, env.cap_id,
            run.task_id, run.id as run_id, lin.id as lineage_id, res.lease_id,
            held_lease.delegation_id`;

export const AFFECTED_JOINS = `from public.reservations res
       join public.task_envelopes env on env.business_id = res.business_id and env.id = res.envelope_id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.proposal_lineages lin on lin.business_id = res.business_id and lin.id = run.lineage_id
       join public.proposal_versions ver on ver.business_id = res.business_id and ver.id = res.version_id
       left join public.leases held_lease
         on held_lease.business_id = res.business_id and held_lease.id = res.lease_id`;

/** The complete lock set for a discovered affected set, in `LOCK_ORDER`. `acquire` sorts it. */
export function locksFor(affected: readonly Affected[]): readonly LockRequest[] {
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
 * Classify each row in the order given, under the caller's locks. One at a
 * time, inside the caller's transaction: running these in parallel would
 * interleave their reads of the same envelope totals. `prepare`, when given,
 * runs for a row immediately before that row is classified.
 */
export async function classifyAll<T>(
  tx: TenantQuery,
  rows: readonly T[],
  locks: LockSet,
  request: (row: T) => ClassifyRequest,
  prepare?: (row: T) => Promise<void>,
): Promise<Classification[]> {
  const one = async (row: T): Promise<Classification> => {
    if (prepare !== undefined) await prepare(row);
    return await classifyUnderLocks(tx, request(row), locks);
  };
  const classified: Classification[] = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    classified.push(await one(row));
  }
  return classified;
}

/** The eligible set, business-wide or scoped to one lineage. Read-only; acquires nothing. */
export async function discoverEligible(
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
       left join public.delegations held_delegation
         on held_delegation.business_id = res.business_id
        and held_delegation.id = held_lease.delegation_id
      where res.business_id = $1
        and res.state = 'held'
        and ($2::uuid is null or lin.id = $2::uuid)
        and (lin.state in ('rejected', 'cancelled')
             or ver.superseded_at is not null
             -- A revocation that committed without its classification:
             -- the delegation row records it, and the lease may still be live.
             or held_delegation.revoked_at is not null
             -- R5. A hold still bound to a lease the server has already fenced
             -- has a recorded transition and no classification, which is the
             -- exactly-once case W04 asks recovery to finish. It is still not
             -- a clock: the lease's own terminal state is the fact, and a live
             -- lease -- expired by its timestamp or not -- is not in this set.
             or held_lease.state in ('expired', 'released'))
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
  return await classifyAll(tx, rows, locks, (row) => ({ reservationId: row.id, cause, causeId }));
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
 * The revocation race. `grant.revoke` takes
 * `for update` on the grant row before any runtime lock, then rediscovers the
 * live leases its loss affects. A pickup that read the grant before that
 * revocation and committed after its rediscovery would be a live claim nobody
 * classified. Holding `for share` on every grant the claim's authority could
 * rest on -- the subjects' own grants in this collection and each grant they
 * descend from -- makes the two serialise: a revocation that locked first is
 * seen by the authority read below, and one that locks second waits for this
 * pickup to commit and then finds its lease.
 *
 * It is taken before the runtime set, where `grant.revoke` takes its own, so
 * neither side ever waits on a grant row while holding a runtime lock.
 * `task.decide` holds its decide grants the same way,
 * which is why this lives here, beside the authority-loss classifier
 * `grant.revoke` runs, rather than in either caller.
 */
export async function holdCoveringGrants(
  tx: TenantQuery,
  subjects: readonly Subject[],
  collection: string,
  // `nowait` is for a hold taken under runtime locks (the top-up's late first
  // approver): it never waits on a grant row there, and contention rolls back.
  wait: 'wait' | 'nowait' = 'wait',
): Promise<void> {
  await tx.query(
    `with recursive chain as (
       select g.id, g.parent_grant_id from public.grants g
        where g.business_id = $1 and g.collection = $2
          and exists (select 1 from unnest($3::text[], $4::uuid[]) as s (kind, id)
                       where s.kind = g.subject_kind and s.id = g.subject_id)
       union
       select p.id, p.parent_grant_id from public.grants p
         join chain c on p.id = c.parent_grant_id
        where p.business_id = $1
     )
     select g.id from public.grants g
      where g.business_id = $1 and g.id in (select id from chain)
      order by g.id
      for share${wait === 'nowait' ? ' nowait' : ''}`,
    [
      tx.businessId,
      collection,
      subjects.map((subject) => subject.kind),
      subjects.map((subject) => subject.id),
    ],
  );
}

/**
 * `checkAuthority` judged at `at`, the instant read once the locks are held
 * (`clock.ts`), rather than at `now()`, the transaction's start. A grant that
 * lapsed while the caller waited on its locks no longer counts.
 *
 * The effective set already applies every ancestor's revocation and expiry as
 * of `now()`, and a child never outlives its parent (`grants.ts`, EFFECTIVE),
 * so a returned grant's own `expires_at` bounds its whole chain: dropping the
 * ones that end at or before `at` is the chain judged at `at`. The compare is
 * the database's, because a `Date` keeps milliseconds and the column keeps
 * microseconds.
 */
export async function checkAuthorityAt(
  tx: TenantQuery,
  subjects: readonly Subject[],
  request: ScopeRequest,
  at: string,
): Promise<Decision<readonly EffectiveGrant[]>> {
  const decision = await checkAuthority(tx, subjects, request);
  if (!decision.ok) return decision;
  const live = await tx.query<{ readonly id: string }>(
    `select id from public.grants
      where business_id = $1 and id = any($2::uuid[])
        and (expires_at is null or expires_at > $3::timestamptz)`,
    [tx.businessId, decision.value.map((grant) => grant.id), at],
  );
  const ids = new Set(live.map((row) => row.id));
  const value = decision.value.filter((grant) => ids.has(grant.id));
  if (value.length === 0) {
    return {
      ok: false,
      refusal: refuseCommand(
        'SCOPE_NOT_GRANTED',
        [],
        ['no live grant covers it', 'ask a holder who may delegate'],
      ),
    };
  }
  return { ok: true, value };
}
