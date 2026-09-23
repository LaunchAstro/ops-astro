// SPDX-License-Identifier: AGPL-3.0-only
//
// T4: handback. Atomic, fenced, and it settles work and money as two facts.
//
// **A stale fence cannot hand back.** The fence is the identity of the claim,
// not of the task. A holder whose lease expired and was replaced presents the
// old fence, and every path here refuses before it writes: `LEASE_EXPIRED`
// when the lease itself is done, `LEASE_NOT_OWNED` when a live lease exists
// and it is somebody else's. Its report can be retained separately; it cannot
// settle the replacement's work (W03).
//
// **The lease closing and the hold closing are separate.** Settling the lease
// says the claim is over. Turning the reservation into an actual says what it
// cost. A handback that did both in one column could not express the case T5
// exists for: work that ended with no cost and no observation, where the
// honest terminal state is `abandoned` rather than an invented zero.
//
// The classifier is invoked as a helper with the locks already held. It takes
// no lock of its own, which is the "helpers receive the already-held lock
// context" rule as an argument rather than as a comment.

import type { TenantQuery } from '../../core-records/src/tenancy/database.ts';
import { settleDelegation } from '../../core-records/src/authority/delegations.ts';
import { acquire } from './locks.ts';
import { classifyUnderLocks, type Classification } from './recovery.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

export interface HandbackRequest {
  readonly leaseId: string;
  /** The fence the holder believes it owns. Compared under the locks. */
  readonly fence: number;
  readonly outcome: 'completed' | 'failed';
  readonly report: Record<string, unknown>;
  /**
   * What the work actually cost, in minor units. `null` is the honest answer
   * in this head: nothing was dispatched, so nothing was spent, and the hold
   * is abandoned rather than settled at a fabricated zero.
   */
  readonly actualMinor: number | null;
}

export interface HandedBack {
  readonly leaseId: string;
  readonly reservationId: string;
  readonly attemptId: string;
  readonly reservationState: 'actual' | 'abandoned' | 'held' | 'quarantined';
  readonly classification: Classification | null;
  readonly envelopeHeldMinor: number;
  readonly envelopeActualMinor: number;
}

export async function handback(
  tx: TenantQuery,
  request: HandbackRequest,
): Promise<RuntimeResult<HandedBack>> {
  const discovered = await tx.query<{
    readonly id: string;
    readonly task_id: string;
    readonly run_id: string;
    readonly reservation_id: string;
    readonly delegation_id: string | null;
    readonly envelope_id: string;
    readonly lineage_id: string;
    readonly cap_id: string;
  }>(
    `select l.id, l.task_id, l.run_id, l.reservation_id, l.delegation_id,
            res.envelope_id, run.lineage_id, env.cap_id
       from public.leases l
       join public.reservations res on res.business_id = l.business_id and res.id = l.reservation_id
       join public.task_envelopes env on env.business_id = l.business_id and env.id = res.envelope_id
       join public.planned_runs run on run.business_id = l.business_id and run.id = l.run_id
      where l.business_id = $1 and l.id = $2`,
    [tx.businessId, request.leaseId],
  );
  const found = discovered[0];
  if (found === undefined) {
    return refuse(
      'LEASE_NOT_OWNED',
      `no lease ${request.leaseId} in this business`,
      'Hand back the lease this claim was issued.',
    );
  }

  // The complete set. The envelope is locked even though the ordinary handback
  // does not change the cap — "it must lock that envelope even when it need
  // not lock an unchanged cap" (T4). The cap is locked too, because the
  // classifier's release reads the cap's committed total.
  await acquire(tx, [
    { lockClass: 'cap', id: found.cap_id },
    { lockClass: 'envelope', id: found.envelope_id },
    { lockClass: 'task', id: found.task_id },
    { lockClass: 'run', id: found.run_id },
    { lockClass: 'lineage', id: found.lineage_id },
    { lockClass: 'lease', id: request.leaseId },
    ...(found.delegation_id === null
      ? []
      : [{ lockClass: 'delegation' as const, id: found.delegation_id }]),
    { lockClass: 'reservation', id: found.reservation_id },
  ]);

  const leases = await tx.query<{
    readonly state: string;
    readonly fence: string;
    readonly expired: boolean;
    readonly current_fence: string;
  }>(
    `select l.state, l.fence::text as fence, (l.expires_at <= now()) as expired,
            (select max(fence) from public.leases
              where business_id = l.business_id and task_id = l.task_id)::text as current_fence
       from public.leases l where l.business_id = $1 and l.id = $2`,
    [tx.businessId, request.leaseId],
  );
  const lease = leases[0] as {
    state: string;
    fence: string;
    expired: boolean;
    current_fence: string;
  };

  // The fence check, before anything is written. Three distinct causes, each
  // with its own code, because a caller told the wrong one retries wrongly.
  if (Number(lease.fence) !== request.fence) {
    return refuse(
      'LEASE_NOT_OWNED',
      `lease ${request.leaseId} holds fence ${lease.fence}, and fence ${request.fence} was presented`,
      'Read the fence from the pickup that issued the lease.',
    );
  }
  if (Number(lease.fence) < Number(lease.current_fence)) {
    return refuse(
      'LEASE_NOT_OWNED',
      `fence ${request.fence} has been superseded by ${lease.current_fence} on this task`,
      'The replacement owns the work. This report is retained, not settled.',
    );
  }
  if (lease.state !== 'live') {
    return refuse(
      'LEASE_EXPIRED',
      `lease ${request.leaseId} is ${lease.state}`,
      'A settled or expired lease cannot settle work. Pick the work up again.',
    );
  }
  if (lease.expired) {
    return refuse(
      'LEASE_EXPIRED',
      `lease ${request.leaseId} expired before this handback`,
      'Pick the work up again under a new lease and a new fence.',
    );
  }

  const attempts = await tx.query<{ readonly id: string; readonly marked: boolean }>(
    `select id, (dispatch_marker or observed) as marked from public.attempts
      where business_id = $1 and reservation_id = $2`,
    [tx.businessId, found.reservation_id],
  );
  const attempt = attempts[0] as { id: string; marked: boolean };

  await tx.query(
    `update public.leases set state = 'released', released_at = now()
      where business_id = $1 and id = $2`,
    [tx.businessId, request.leaseId],
  );
  if (found.delegation_id !== null) await settleDelegation(tx, found.delegation_id);
  await tx.query(
    `update public.planned_runs set state = 'handed_back' where business_id = $1 and id = $2`,
    [tx.businessId, found.run_id],
  );
  await tx.query(
    `update public.attempts set state = 'handed_back', outcome = $3
      where business_id = $1 and id = $2`,
    [tx.businessId, attempt.id, request.outcome],
  );

  let reservationState: HandedBack['reservationState'] = 'held';
  let classification: Classification | null = null;

  if (request.actualMinor !== null) {
    // A real cost. The hold becomes an actual of that amount and the envelope
    // moves the number from one total to the other in one statement, so no
    // reader ever sees it counted twice or not at all.
    await tx.query(
      `update public.reservations
          set state = 'actual', actual_minor = $3, terminal_at = now()
        where business_id = $1 and id = $2 and state = 'held'`,
      [tx.businessId, found.reservation_id, request.actualMinor],
    );
    await tx.query(
      `update public.attempts set actual_minor = $3, settled_at = now()
        where business_id = $1 and id = $2`,
      [tx.businessId, attempt.id, request.actualMinor],
    );
    const held = await tx.query<{ readonly held_minor: string }>(
      `select held_minor::text as held_minor from public.reservations
        where business_id = $1 and id = $2`,
      [tx.businessId, found.reservation_id],
    );
    await tx.query(
      `update public.task_envelopes
          set held_minor = held_minor - $3, actual_minor = actual_minor + $4
        where business_id = $1 and id = $2`,
      [tx.businessId, found.envelope_id, Number(held[0]?.held_minor ?? 0), request.actualMinor],
    );
    reservationState = 'actual';
  } else {
    // No cost and nothing observed. The classifier decides, under the locks
    // this transaction already holds, whether the hold may be abandoned — and
    // a marked attempt keeps its full hold as quarantined instead.
    classification = await classifyUnderLocks(tx, {
      reservationId: found.reservation_id,
      cause: 'handback_completed',
      causeId: request.leaseId,
    });
    reservationState = attempt.marked
      ? 'quarantined'
      : classification.released
        ? 'abandoned'
        : 'held';
  }

  // No audit row is written here. `audit_events` is written through L3's
  // command envelope, which owns the actor, the operation identity and the
  // chain; a second writer reaching into that table from this package would be
  // a second shape of the same trail, and the first attempt at it aborted the
  // whole handback transaction on a column that does not exist. The handback's
  // own durable facts are the released lease, the settled delegation, the
  // attempt outcome and the reservation's disposition above. Named in the
  // handback as an interface L3 supplies.

  const envelopes = await tx.query<{ readonly held_minor: string; readonly actual_minor: string }>(
    `select held_minor::text as held_minor, actual_minor::text as actual_minor
       from public.task_envelopes where business_id = $1 and id = $2`,
    [tx.businessId, found.envelope_id],
  );

  return {
    ok: true,
    value: {
      leaseId: request.leaseId,
      reservationId: found.reservation_id,
      attemptId: attempt.id,
      reservationState,
      classification,
      envelopeHeldMinor: Number(envelopes[0]?.held_minor ?? 0),
      envelopeActualMinor: Number(envelopes[0]?.actual_minor ?? 0),
    },
  };
}
