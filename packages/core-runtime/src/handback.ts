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
//
// **The successor is part of the settlement, not a second call.** T4: "where
// approval is required, create the successor proposal/run/step/evidence pack
// and pending gate in this same transaction through a lock-aware production
// proposal writer", and "a fault rolls back work settlement, accounting
// release, successor creation and the success receipt together". The successor
// input is therefore bounded here and written through `proposal-writer.ts`
// under this transaction's own locks -- never through `propose`, which would
// check the wrong actor's authority and open a lock set of its own part-way
// through a transaction already holding the lease. It is not approved and it
// opens no hold; what it creates is a pending gate somebody has to decide.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/tenancy/database.ts';
import { settleDelegation } from '../../core-records/src/authority/delegations.ts';
import { checkAuthority, type Subject } from '../../core-records/src/authority/grants.ts';
import { lockedInstant } from './clock.ts';
import { acquire } from './locks.ts';
import { only } from './only.ts';
import {
  AffectedSetChanged,
  classifyUnderLocks,
  endLease,
  type Classification,
} from './recovery.ts';
import { roundsUsed, writeProposal } from './proposal-writer.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

/**
 * The bounded successor a handback may ask for. Bounded is the whole point: a
 * settlement is not an authority to propose whatever it likes, so the ceiling
 * has to fit the cap the envelope draws on, the currency has to be the one that
 * envelope holds, and the lineage's formal rounds have to be unspent (G08).
 * Outside any of those it is refused before the first write.
 */
export interface SuccessorRequest {
  /** The actor this proposal is recorded as coming from. Its authority is the caller's to check. */
  readonly proposedByActorId: string;
  readonly purpose: string;
  /** The finite ceiling the successor asks for, in minor units. */
  readonly maximumMinor: number;
  readonly currency: string;
  readonly payload: Record<string, unknown>;
  readonly step: { readonly kind: string; readonly payload: Record<string, unknown> };
  readonly expiresAt: Date;
}

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
  /**
   * Optional: absent is the ordinary handback, which settles and proposes
   * nothing. Present asks for the successor proposal and its pending gate on
   * the same lineage, in this same transaction.
   */
  readonly successor?: SuccessorRequest;
  /**
   * Who is handing back, checked against the lease under the locks. Absent is
   * the pre-EX-01 caller, which is the lower-level helper's own tests. An
   * agent is the lease's holder with the delegation the envelope already
   * resolved; a person is the holder of a lease that carries no delegation,
   * with their own current write on the task (T3 line 66, ledger line 31 read
   * conditionally: the owned lease, plus its delegation when an agent holds it).
   */
  readonly holder?: HandbackHolder;
}

export type HandbackHolder =
  | { readonly claimant: 'agent'; readonly actorId: string }
  | {
      readonly claimant: 'person';
      readonly actorId: string;
      readonly subjects: readonly Subject[];
      readonly collection: string;
    };

export interface HandedBack {
  readonly leaseId: string;
  /** The durable report this handback stored (R4). Its identity, not its content. */
  readonly reportId: string;
  readonly reservationId: string;
  readonly attemptId: string;
  readonly reservationState: 'actual' | 'abandoned' | 'held' | 'quarantined';
  readonly classification: Classification | null;
  readonly envelopeHeldMinor: number;
  readonly envelopeActualMinor: number;
  /**
   * The successor's durable handles, or `null` throughout when none was asked
   * for. They are returned beside `reportId` because T4 wants "the durable
   * handback/proposal handles in one response".
   */
  readonly successorVersionId: string | null;
  readonly successorGateId: string | null;
  readonly successorRunId: string | null;
  readonly successorStepId: string | null;
}

/** Why a stale holder's report is retained rather than settled, and what it is told. */
export interface StaleVerdict {
  readonly code: 'LEASE_NOT_OWNED' | 'LEASE_EXPIRED';
  readonly reason: string;
  readonly fix: string;
}

/**
 * The lease's rungs of the fence ladder, as a pure reading of the lease row
 * `handback` has under its locks. The four causes are asked in this order and
 * the first that holds is the answer; `null` is the current holder of a live
 * lease. Asked before the binding is read, so a stale fence is refused without
 * the binding query or its discovery-changed recheck ever running.
 */
export function fenceVerdict(
  lease: {
    readonly state: string;
    readonly fence: string;
    readonly expired: boolean;
    readonly current_fence: string;
  },
  request: { readonly leaseId: string; readonly fence: number },
): StaleVerdict | null {
  if (Number(lease.fence) !== request.fence) {
    return {
      code: 'LEASE_NOT_OWNED',
      reason: `lease ${request.leaseId} holds fence ${lease.fence}, and fence ${request.fence} was presented`,
      fix: 'Read the fence from the pickup that issued the lease. The report is retained, not settled.',
    };
  }
  if (Number(lease.fence) < Number(lease.current_fence)) {
    return {
      code: 'LEASE_NOT_OWNED',
      reason: `fence ${request.fence} has been superseded by ${lease.current_fence} on this task`,
      fix: 'The replacement owns the work. This report is retained, not settled.',
    };
  }
  if (lease.state !== 'live') {
    return {
      code: 'LEASE_EXPIRED',
      reason: `lease ${request.leaseId} is ${lease.state}`,
      fix: 'A settled or expired lease cannot settle work. The report is retained; pick the work up again.',
    };
  }
  if (lease.expired) {
    return {
      code: 'LEASE_EXPIRED',
      reason: `lease ${request.leaseId} expired before this handback`,
      fix: 'Pick the work up again under a new lease and a new fence. The report is retained.',
    };
  }
  return null;
}

/**
 * The ladder's last rung, asked once the lease has passed `fenceVerdict` and
 * the binding has been read under the locks: work on a superseded version or a
 * lineage that is no longer live cannot settle. `null` is live work.
 */
export function bindingVerdict(binding: {
  readonly version_id: string;
  readonly superseded: boolean;
  readonly lineage_state: string;
}): StaleVerdict | null {
  if (binding.superseded || binding.lineage_state !== 'live') {
    return {
      code: 'LEASE_NOT_OWNED',
      reason: binding.superseded
        ? `the version ${binding.version_id} this lease worked has been superseded, so its work cannot settle`
        : `the lineage this lease worked is ${binding.lineage_state}, so its work cannot settle`,
      fix: 'The report is retained, not accepted. Work the current version under a new pickup.',
    };
  }
  return null;
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
      // Constant: the presented id is not echoed (root ruling 2).
      'no such lease in this business',
      'Hand back the lease this claim was issued.',
    );
  }

  // T4 names "proposal-lineage coordination and affected gate rows" in the set.
  // A successor supersedes whatever is still pending on this lineage, so those
  // gate rows are affected rows and they are discovered here, before the locks,
  // rather than met by an update inside them.
  const pending = await tx.query<{ readonly id: string }>(
    `select g.id from public.gates g
       join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
      where g.business_id = $1 and v.lineage_id = $2 and g.state = 'pending'`,
    [tx.businessId, found.lineage_id],
  );

  // The complete set. The envelope is locked even though the ordinary handback
  // does not change the cap — "it must lock that envelope even when it need
  // not lock an unchanged cap" (T4). The cap is locked too, because the
  // classifier's release reads the cap's committed total.
  const locks = await acquire(tx, [
    { lockClass: 'cap', id: found.cap_id },
    { lockClass: 'envelope', id: found.envelope_id },
    { lockClass: 'task', id: found.task_id },
    { lockClass: 'run', id: found.run_id },
    { lockClass: 'lineage', id: found.lineage_id },
    ...pending.map((row) => ({ lockClass: 'gate' as const, id: row.id })),
    { lockClass: 'lease', id: request.leaseId },
    ...(found.delegation_id === null
      ? []
      : [{ lockClass: 'delegation' as const, id: found.delegation_id }]),
    { lockClass: 'reservation', id: found.reservation_id },
  ]);

  // Sol 6 RUNTIME-1 (158d6de): `now()` is when this transaction began, and a
  // handback that waited on these locks past the lease's expiry would still
  // see the lease live and settle work an expired lease cannot settle. The
  // expiry is judged on the clock read here, after the locks.
  const lockedAt = await lockedInstant(tx);

  const leases = await tx.query<{
    readonly state: string;
    readonly fence: string;
    readonly expired: boolean;
    readonly current_fence: string;
    readonly holder_actor_id: string;
  }>(
    `select l.state, l.fence::text as fence, (l.expires_at <= $3::timestamptz) as expired,
            l.holder_actor_id,
            (select max(fence) from public.leases
              where business_id = l.business_id and task_id = l.task_id)::text as current_fence
       from public.leases l where l.business_id = $1 and l.id = $2`,
    [tx.businessId, request.leaseId, lockedAt],
  );
  const lease = only(leases, 'handback: the lease locked above');

  // EX-01. Ownership before anything is written, retained reports included: a
  // caller that never held this lease has no work of its own on it to keep.
  // A person never settles an agent's lease or another person's, and an agent
  // never settles a person's.
  const holder = request.holder;
  if (holder !== undefined) {
    const personLease = found.delegation_id === null;
    if (
      lease.holder_actor_id !== holder.actorId ||
      personLease !== (holder.claimant === 'person')
    ) {
      return refuse(
        'LEASE_NOT_OWNED',
        "the named lease is not this caller's",
        'Hand back the lease your own pickup was issued.',
      );
    }
    if (holder.claimant === 'person') {
      const held = await checkAuthority(tx, holder.subjects, {
        collection: holder.collection,
        action: 'write',
        scope: { kind: 'record', id: found.task_id },
      });
      if (!held.ok) {
        return refuse(
          'SCOPE_NOT_GRANTED',
          `no live grant of yours covers work on task ${found.task_id} any more`,
          'A lease is handed back under current rights. Ask a manager for write on this task.',
        );
      }
    }
  }

  /**
   * R4. A stale holder's work was still really done, and T4 keeps it: the
   * report is retained separately, and the refusal is still the answer. The
   * row records which refusal retained it, so a reader can tell a retained
   * report from a settlement without joining anything.
   */
  const refuseRetained = async (verdict: StaleVerdict): Promise<RuntimeResult<never>> => {
    await insertReport(tx, {
      id: randomUUID(),
      leaseId: request.leaseId,
      reservationId: found.reservation_id,
      runId: found.run_id,
      fence: request.fence,
      outcome: request.outcome,
      refusalCode: verdict.code,
      report: request.report,
    });
    return refuse(verdict.code, verdict.reason, verdict.fix);
  };

  // The fence check, before anything else is written. Three distinct causes,
  // each with its own code, because a caller told the wrong one retries
  // wrongly. Nothing below changes the task, the gate, the current lease or
  // any money; the retained report is append-only evidence.
  const fenced = fenceVerdict(lease, request);
  if (fenced !== null) return refuseRetained(fenced);

  // F3. The lease is live and fenced, and that is still not enough: the work
  // it holds is bound to one reservation and one approved version, and T4
  // re-reads "every parent link, active proposal version ... and reservation
  // eligibility after all locks are held". A version a person has superseded,
  // or a lineage that is no longer live, is work nobody may settle, and its
  // successor would supersede the newer proposal from stale work. The report
  // is retained unaccepted and nothing else is written.
  const bound = await tx.query<{
    readonly lease_reservation: string;
    readonly version_id: string;
    readonly superseded: boolean;
    readonly lineage_state: string;
    readonly lineage_id: string;
  }>(
    `select l.reservation_id as lease_reservation, res.version_id,
            (ver.superseded_at is not null) as superseded, lin.state as lineage_state,
            lin.id as lineage_id
       from public.leases l
       join public.reservations res on res.business_id = l.business_id and res.id = l.reservation_id
       join public.proposal_versions ver on ver.business_id = res.business_id and ver.id = res.version_id
       join public.proposal_lineages lin on lin.business_id = ver.business_id and lin.id = ver.lineage_id
      where l.business_id = $1 and l.id = $2`,
    [tx.businessId, request.leaseId],
  );
  const binding = bound[0];
  if (
    binding === undefined ||
    binding.lease_reservation !== found.reservation_id ||
    binding.lineage_id !== found.lineage_id
  ) {
    throw new AffectedSetChanged(
      'handback: the lease binding changed under discovery; roll back and rediscover rather than extending the lock set',
    );
  }
  const unbound = bindingVerdict(binding);
  if (unbound !== null) return refuseRetained(unbound);

  // R6. This head exports no dispatch, no worker and no provider adapter, so a
  // reported cost -- including zero -- is a number nothing observed. Settling
  // on it would write expenditure the accepted first-head boundary says cannot
  // exist, and a fabricated zero is exactly the "fake zero-cost settlement" T5
  // names. Refused before the first write; the hold stays whole.
  if (request.actualMinor !== null) {
    return refuse(
      'ACTUAL_EXPENDITURE_UNSUPPORTED',
      `this handback reports ${request.actualMinor} minor units of actual expenditure, and no path in this head can have spent it`,
      'Hand back with a null actual. Settling real provider usage belongs to the later authorised, evidence-backed accounting path.',
    );
  }

  // R4, the successor half. Bounded under the locks and before the first write,
  // so an out-of-bounds successor costs the caller a refusal rather than a
  // settlement it then has to undo. Reached only past the fence checks above,
  // which is what makes "a stale fence cannot hand back" also mean a stale
  // fence cannot propose: those paths retain their report and return.
  const successor = request.successor;
  if (successor !== undefined) {
    const bounded = await withinBounds(tx, successor, found);
    if (bounded !== null) return bounded;
  }

  const attempts = await tx.query<{ readonly id: string; readonly marked: boolean }>(
    `select id, (dispatch_marker or observed) as marked from public.attempts
      where business_id = $1 and reservation_id = $2`,
    [tx.businessId, found.reservation_id],
  );
  const attempt = only(attempts, "handback: the reservation's attempt");

  // R4. The work, retained. It commits with the settlement below or with
  // neither of them, which is what makes it the handback's evidence rather
  // than a note somebody wrote near it.
  const reportId = randomUUID();
  await insertReport(tx, {
    id: reportId,
    leaseId: request.leaseId,
    reservationId: found.reservation_id,
    runId: found.run_id,
    fence: request.fence,
    outcome: request.outcome,
    refusalCode: null,
    report: request.report,
  });

  // Live and fenced under the lease lock (`fenceVerdict` above), so the guard
  // in `endLease` changes nothing here.
  await endLease(tx, request.leaseId, 'released');
  if (found.delegation_id !== null) await settleDelegation(tx, found.delegation_id);
  await tx.query(
    `update public.planned_runs set state = 'handed_back' where business_id = $1 and id = $2`,
    [tx.businessId, found.run_id],
  );
  // R7. The marker is read under the locks and decides whether the attempt's
  // disposition may move at all. `attempts_marked_is_quarantined` (0014:82-85)
  // requires a marked or observed attempt to sit in `quarantined`, so writing
  // `handed_back` over it aborts the transaction before the classifier can run
  // and the documented quarantine result becomes unreachable. A marked attempt
  // is therefore left to the classifier, which quarantines it and keeps the
  // full hold for the recorded reconciliation owner.
  if (!attempt.marked) {
    await tx.query(
      `update public.attempts set state = 'handed_back', outcome = $3
        where business_id = $1 and id = $2`,
      [tx.businessId, attempt.id, request.outcome],
    );
  }

  // No cost and nothing observed, because R6 refused every other case above.
  // The classifier decides, under the locks this transaction already holds,
  // whether the hold may be abandoned -- and a marked attempt keeps its full
  // hold as quarantined instead. The settlement branch that used to sit here
  // is gone rather than guarded: a branch that can only ever write a number
  // nothing observed is not a branch this head should be able to reach.
  const classification: Classification = await classifyUnderLocks(
    tx,
    {
      reservationId: found.reservation_id,
      cause: 'handback_completed',
      causeId: request.leaseId,
    },
    locks,
  );
  const reservationState: HandedBack['reservationState'] = classification.state;

  // No audit row is written here. `audit_events` is written through L3's
  // command envelope, which owns the actor, the operation identity and the
  // chain; a second writer reaching into that table from this package would be
  // a second shape of the same trail, and the first attempt at it aborted the
  // whole handback transaction on a column that does not exist. The handback's
  // own durable facts are the released lease, the settled delegation, the
  // attempt outcome and the reservation's disposition above. Named in the
  // handback as an interface L3 supplies.

  // The successor, in this transaction, through the lock-aware writer and under
  // the locks taken above. After the settlement on purpose: the classification
  // is what makes the old attempt nonclaimable, and the successor is the work
  // somebody may now approve instead. Neither is committable without the other.
  let written: {
    readonly versionId: string;
    readonly gateId: string;
    readonly runId: string;
    readonly stepId: string;
  } | null = null;
  if (successor !== undefined) {
    const proposal = await writeProposal(
      tx,
      {
        taskId: found.task_id,
        lineageId: found.lineage_id,
        envelopeId: found.envelope_id,
        capId: found.cap_id,
        proposedByActorId: successor.proposedByActorId,
        purpose: successor.purpose,
        maximumMinor: successor.maximumMinor,
        currency: successor.currency,
        payload: successor.payload,
        step: successor.step,
        expiresAt: successor.expiresAt,
      },
      locks,
    );
    if (!proposal.ok) return proposal;
    written = proposal.value;
  }

  const envelopes = await tx.query<{ readonly held_minor: string; readonly actual_minor: string }>(
    `select held_minor::text as held_minor, actual_minor::text as actual_minor
       from public.task_envelopes where business_id = $1 and id = $2`,
    [tx.businessId, found.envelope_id],
  );

  return {
    ok: true,
    value: {
      leaseId: request.leaseId,
      reportId,
      reservationId: found.reservation_id,
      attemptId: attempt.id,
      reservationState,
      classification,
      envelopeHeldMinor: Number(envelopes[0]?.held_minor ?? 0),
      envelopeActualMinor: Number(envelopes[0]?.actual_minor ?? 0),
      successorVersionId: written?.versionId ?? null,
      successorGateId: written?.gateId ?? null,
      successorRunId: written?.runId ?? null,
      successorStepId: written?.stepId ?? null,
    },
  };
}

/**
 * The historical holder's report, retained and nothing else (T4: "a restricted
 * evidence-only handback intake ... authenticates the historical actor/lease
 * binding, writes only an append-only report and never changes the task,
 * gate, current lease or money").
 *
 * The caller has already bound the credential to a delegation that is no
 * longer live. This binds the rest under the same row: the lease is that
 * delegation's, held by that agent, and the fence is the one it was issued.
 * Any of them wrong and nothing is written. When they all hold, one
 * `retained` row records the report and the refusal that kept it; no lease,
 * delegation, run, attempt, reservation, gate or envelope is read for update
 * or written, and no successor is considered. Returns whether a row was kept.
 */
export async function retainHistoricalReport(
  tx: TenantQuery,
  intake: {
    readonly leaseId: string;
    readonly delegationId: string;
    readonly holderActorId: string;
    readonly fence: number;
    readonly outcome: string;
    readonly report: Readonly<Record<string, unknown>>;
    readonly refusalCode: string;
  },
): Promise<boolean> {
  if (intake.outcome !== 'completed' && intake.outcome !== 'failed') return false;
  if (!Number.isSafeInteger(intake.fence)) return false;
  const leases = await tx.query<{ readonly reservation_id: string; readonly run_id: string }>(
    `select reservation_id, run_id from public.leases
      where business_id = $1 and id = $2 and delegation_id = $3 and holder_actor_id = $4
        and fence = $5`,
    [tx.businessId, intake.leaseId, intake.delegationId, intake.holderActorId, intake.fence],
  );
  const lease = leases[0];
  if (lease === undefined) return false;
  await insertReport(tx, {
    id: randomUUID(),
    leaseId: intake.leaseId,
    reservationId: lease.reservation_id,
    runId: lease.run_id,
    fence: intake.fence,
    outcome: intake.outcome,
    refusalCode: intake.refusalCode,
    report: intake.report,
  });
  return true;
}

/**
 * One `handback_reports` row, the only writer of that table. The disposition
 * is read off the refusal rather than passed beside it: a settled report was
 * refused by nothing and a retained one was kept by exactly one refusal, the
 * rule `handback_reports_refusal_matches_disposition` enforces (0018), so
 * the two cannot be handed in disagreeing.
 */
async function insertReport(
  tx: TenantQuery,
  row: {
    readonly id: string;
    readonly leaseId: string;
    readonly reservationId: string;
    readonly runId: string;
    readonly fence: number;
    readonly outcome: string;
    readonly refusalCode: string | null;
    readonly report: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await tx.query(
    `insert into public.handback_reports
       (business_id, id, lease_id, reservation_id, run_id, fence, disposition,
        outcome, refusal_code, report)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text::jsonb)`,
    [
      tx.businessId,
      row.id,
      row.leaseId,
      row.reservationId,
      row.runId,
      row.fence,
      row.refusalCode === null ? 'settled' : 'retained',
      row.outcome,
      row.refusalCode,
      JSON.stringify(row.report),
    ],
  );
}

/**
 * The successor's three bounds, read under the caller's locks. Returns `null`
 * when it fits and the refusal otherwise, so each answer names the bound that
 * was missed rather than "out of bounds".
 *
 * The cap, not the envelope's own maximum, is the ceiling asked about here: the
 * envelope's maximum was fixed by the first version it held and raising it is
 * its own authorised decision, while the cap is the finite ceiling T2 calls
 * canonical. A successor that fits the cap and not the envelope is refused by
 * `decide` on the envelope's own ground, with its own code, if anyone approves
 * it.
 */
async function withinBounds(
  tx: TenantQuery,
  successor: SuccessorRequest,
  found: { readonly envelope_id: string; readonly cap_id: string; readonly lineage_id: string },
): Promise<RuntimeResult<never> | null> {
  if (!Number.isSafeInteger(successor.maximumMinor) || successor.maximumMinor <= 0) {
    return refuse(
      'SUCCESSOR_OUT_OF_BOUNDS',
      `a bounded successor needs a finite positive ceiling, and this one asks for ${successor.maximumMinor}`,
      'Name a maximum in minor units greater than zero.',
    );
  }

  const rows = await tx.query<{
    readonly currency: string;
    readonly limit_minor: string;
    readonly committed: string;
  }>(
    `select env.currency, cap.limit_minor::text as limit_minor,
            coalesce((select sum(e.held_minor + e.actual_minor) from public.task_envelopes e
                       where e.business_id = cap.business_id and e.cap_id = cap.id), 0)::text
              as committed
       from public.task_envelopes env
       join public.budget_caps cap on cap.business_id = env.business_id and cap.id = env.cap_id
      where env.business_id = $1 and env.id = $2`,
    [tx.businessId, found.envelope_id],
  );
  const bounds = rows[0];
  if (bounds === undefined) {
    return refuse(
      'SUCCESSOR_OUT_OF_BOUNDS',
      `the envelope ${found.envelope_id} this handback settles has no readable cap to bound a successor by`,
      'Hand back without a successor and propose through the ordinary authorised path.',
    );
  }

  if (successor.currency !== bounds.currency) {
    return refuse(
      'SUCCESSOR_OUT_OF_BOUNDS',
      `this task's envelope is in ${bounds.currency} and the successor is in ${successor.currency}`,
      'Propose the successor in the currency the envelope holds.',
    );
  }

  // Sol 6 RUNTIME-2 (158d6de): exact, as approval is. A cap above 2^53 is
  // valid, and as numbers its limit and committed total round, so a successor
  // could be admitted beyond the room that is really left.
  const room = BigInt(bounds.limit_minor) - BigInt(bounds.committed);
  if (BigInt(successor.maximumMinor) > room) {
    return refuse(
      'SUCCESSOR_OUT_OF_BOUNDS',
      `the cap behind this envelope has ${bounds.committed} of ${bounds.limit_minor} committed, so a successor asking ${successor.maximumMinor} does not fit its remaining ${String(room)}`,
      'Propose a successor within the cap, or raise the cap through its own authorised decision.',
    );
  }

  // G08. The rounds are the lineage's, not the gate's, and the successor would
  // carry the next one. A lineage that has spent both is a lineage whose next
  // move is an approval, a rejection or an authorised restart on a new lineage.
  const round = await roundsUsed(tx, found.lineage_id);
  if (round > 2) {
    return refuse(
      'SUCCESSOR_OUT_OF_BOUNDS',
      `this lineage has used its two formal rounds, so a successor at round ${round} is a third`,
      'Decide the lineage or restart it on a new one. A third round is not taken here.',
    );
  }

  return null;
}
