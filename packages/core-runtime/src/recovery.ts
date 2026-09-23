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
 */
export async function classifyUnderLocks(
  tx: TenantQuery,
  request: ClassifyRequest,
): Promise<Classification> {
  const rows = await tx.query<{
    readonly state: string;
    readonly envelope_id: string;
    readonly held_minor: string;
    readonly attempt_id: string;
    readonly marked: boolean;
    readonly lease_state: string | null;
  }>(
    `select res.state, res.envelope_id, res.held_minor::text as held_minor,
            att.id as attempt_id, (att.dispatch_marker or att.observed) as marked,
            l.state as lease_state
       from public.reservations res
       join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
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

  // The lease case is the one place elapsed time appears, and even there it is
  // the caller's fencing transition, not a deadline this module invented.
  if (request.cause === 'lease_expired_and_fenced' && row.lease_state === 'live') {
    return {
      reservationId: request.reservationId,
      released: false,
      state: 'held',
      reason: 'the lease is still live, so this attempt is still claimable',
    };
  }

  await tx.query(
    `update public.reservations
        set state = 'abandoned', classified_cause = $3, classified_cause_id = $4, terminal_at = now()
      where business_id = $1 and id = $2 and state = 'held'`,
    [tx.businessId, request.reservationId, request.cause, request.causeId],
  );
  await tx.query(
    `update public.attempts set state = 'abandoned', outcome = coalesce(outcome, 'abandoned')
      where business_id = $1 and id = $2`,
    [tx.businessId, row.attempt_id],
  );
  // Subtracted once, from the held total only. Nothing is added to `actual`:
  // there is no observation to justify a number, not even zero.
  await tx.query(
    `update public.task_envelopes set held_minor = held_minor - $3
      where business_id = $1 and id = $2`,
    [tx.businessId, row.envelope_id, Number(row.held_minor)],
  );

  return {
    reservationId: request.reservationId,
    released: true,
    state: 'abandoned',
    reason: `abandoned under ${request.cause} (${request.causeId}); the hold was released once and no cost was recorded`,
  };
}

/**
 * Restart replay. It finds reservations whose **recorded** transition already
 * made them nonclaimable and whose classification did not commit, and runs the
 * same classifier over them.
 *
 * It manufactures no eligibility. The query below asks only about rows whose
 * lineage is terminal or whose version is superseded — facts another
 * authorised operation wrote — and never about age, a missing claimant or a
 * null lease.
 */
export async function replayRecordedTransitions(
  tx: TenantQuery,
): Promise<readonly Classification[]> {
  const rows = await tx.query<{
    readonly id: string;
    readonly cause: string;
    readonly cause_id: string;
  }>(
    `select res.id,
            case when lin.state in ('rejected', 'cancelled') then 'lineage_' || lin.state
                 else 'version_superseded' end as cause,
            case when lin.state in ('rejected', 'cancelled') then lin.id else ver.id end as cause_id
       from public.reservations res
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.proposal_lineages lin on lin.business_id = res.business_id and lin.id = run.lineage_id
       join public.proposal_versions ver on ver.business_id = res.business_id and ver.id = res.version_id
      where res.business_id = $1
        and res.state = 'held'
        and (lin.state in ('rejected', 'cancelled') or ver.superseded_at is not null)`,
    [tx.businessId],
  );

  const classified: Classification[] = [];
  for (const row of rows) {
    // One at a time, inside the caller's transaction. Running these in
    // parallel would interleave their reads of the same envelope totals.
    // eslint-disable-next-line no-await-in-loop
    const one = await classifyUnderLocks(tx, {
      reservationId: row.id,
      cause: row.cause as NonclaimableCause,
      causeId: row.cause_id,
    });
    classified.push(one);
  }
  return classified;
}

/**
 * The cancellation path's entry point: record the person's cancellation on the
 * lineage, fence and release the live lease, then classify. Exported because
 * T5 names cancellation as one of the owning transitions, and L3 wires it.
 */
export async function cancelAndClassify(
  tx: TenantQuery,
  request: { readonly lineageId: string; readonly reason: string },
): Promise<RuntimeResult<readonly Classification[]>> {
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
  return { ok: true, value: await replayRecordedTransitions(tx) };
}
