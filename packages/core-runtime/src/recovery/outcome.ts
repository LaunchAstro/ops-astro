// SPDX-License-Identifier: AGPL-3.0-only
//
// T3d1: the outcome a person records for an unknown step (`budget.record_outcome`).
//
// A person records one of three outcomes (O7, O8) under `billing:decide`:
// nothing happened (the hold goes back, the work resumes), it happened (the
// whole hold is spent, the work is finished, and a replacement the pass
// reserved is stopped before it dispatches) or it happened differently (the
// whole hold is spent, the work reopens). An unknown effect not yet known is
// no fourth outcome: it keeps its stop. A step a person wrote off still takes
// its outcome later: the write-off's charge stands, and the outcome decides
// only the work.

import { revokeDelegation } from '../../../core-records/src/index.ts';
import type { Subject, TenantQuery } from '../../../core-records/src/index.ts';
import { NO_CALLS, settledAt, type Settlement } from '../budget.ts';
import { lockedInstant } from '../clock.ts';
import type { LockRequest } from '../locks.ts';
import { lockRediscovered } from '../rediscovery.ts';
import { refuse, type RuntimeResult } from '../refusals.ts';
import { closeHold } from '../close-hold.ts';
import { checkAuthorityAt, holdCoveringGrants } from './classifier.ts';
import { modelCallsOn } from '../model-calls-on.ts';
import { endLease } from './lease-retirement.ts';
import { locksOf, resume, settle, UNKNOWN_SELECT, type Unknown } from './reconcile.ts';
import { resolveHeldCalls } from './broker-effect.ts';

export const RECORDED_OUTCOMES = ['nothing_happened', 'happened', 'happened_differently'] as const;
export type RecordedOutcome = (typeof RECORDED_OUTCOMES)[number];

/**
 * Nothing happened, in a person's word: the whole hold goes back, by amount,
 * and the step's work cost nothing. What its model calls settled at did
 * happen, so the hold settles at that (AW-01, `closeHold`); with none, it is
 * abandoned under the recorded outcome (0013: an abandonment names its cause,
 * and an actual is never zero).
 */
async function release(
  tx: TenantQuery,
  row: Pick<Unknown, 'reservation_id' | 'attempt_id' | 'envelope_id' | 'held_minor'>,
  causeId: string = row.attempt_id,
): Promise<Settlement> {
  const { spentMinor } = await modelCallsOn(tx, row.reservation_id);
  await closeHold(
    tx,
    { reservationId: row.reservation_id, envelopeId: row.envelope_id },
    { cause: 'outcome_recorded', causeId },
    spentMinor,
  );
  await tx.query(
    `update public.attempts set state = 'abandoned', outcome = 'abandoned'
      where business_id = $1 and id = $2`,
    [tx.businessId, row.attempt_id],
  );
  return settledAt(BigInt(row.held_minor), spentMinor);
}

/** A hold the pass reserved beside this step's first attempt, when it proved absence. */
interface Replacement {
  readonly reservation_id: string;
  readonly attempt_id: string;
  readonly envelope_id: string;
  readonly held_minor: string;
  readonly lease_id: string | null;
  readonly delegation_id: string | null;
  readonly marked: boolean;
  /** A model call of its worker's is out at the provider, sent before its own dispatch. */
  readonly calling: boolean;
}

async function discoverReplacements(
  tx: TenantQuery,
  row: Unknown,
): Promise<readonly Replacement[]> {
  return await tx.query<Replacement>(
    `select res.id as reservation_id, att.id as attempt_id, res.envelope_id,
            res.held_minor::text as held_minor, l.id as lease_id, l.delegation_id,
            att.dispatch_marker as marked,
            exists (select 1 from public.model_calls c
                     where c.business_id = res.business_id and c.reservation_id = res.id
                       and c.state in ('dispatched', 'liability_unknown')) as calling
       from public.reservations res
       join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
       left join public.leases l
         on l.business_id = res.business_id and l.id = res.lease_id and l.state = 'live'
      where res.business_id = $1 and res.run_id = $2 and att.step_id = $3
        and res.id <> $4 and res.state = 'held'
      order by res.id`,
    [tx.businessId, row.run_id, row.step_id, row.reservation_id],
  );
}

const replacementLocks = (replacements: readonly Replacement[]): readonly LockRequest[] =>
  replacements.flatMap((one): LockRequest[] => [
    { lockClass: 'reservation', id: one.reservation_id },
    ...(one.lease_id === null ? [] : [{ lockClass: 'lease' as const, id: one.lease_id }]),
    ...(one.delegation_id === null
      ? []
      : [{ lockClass: 'delegation' as const, id: one.delegation_id }]),
  ]);

/**
 * `happened` says the work is finished, so
 * a replacement that has sent nothing is stopped under the outcome's locks: its
 * lease ends, its delegation is revoked and its hold goes back, by amount,
 * under the recorded outcome. It never dispatches.
 */
async function stopReplacement(tx: TenantQuery, one: Replacement, causeId: string): Promise<void> {
  if (one.lease_id !== null) await endLease(tx, one.lease_id, 'released');
  if (one.delegation_id !== null) {
    await revokeDelegation(tx, one.delegation_id, 'work_retired');
  }
  await release(tx, one, causeId);
}

/** Whether the step's hold was closed by a person's write-off (`write-off.ts`). */
async function writtenOff(tx: TenantQuery, row: Unknown): Promise<boolean> {
  const [hold] = await tx.query<{ readonly written_off: boolean }>(
    `select classified_cause is not distinct from 'written_off' as written_off
       from public.reservations where business_id = $1 and id = $2`,
    [tx.businessId, row.reservation_id],
  );
  return hold?.written_off === true;
}

/**
 * The outcome of a step already written off: no money moves, the charge
 * stands. Nothing happened, or it happened differently, resumes the work on a
 * fresh hold within the budget, unless the step already went on (an absence
 * the pass proved, or an outcome recorded before), so a second answer resumes
 * nothing.
 */
async function afterWriteOff(
  tx: TenantQuery,
  row: Unknown,
  outcome: RecordedOutcome,
): Promise<OutcomeRecorded> {
  const [later] = await tx.query<{ readonly went_on: boolean }>(
    `select exists (select 1 from public.attempts a
                      join public.reservations r on r.business_id = a.business_id
                                                and r.id = a.reservation_id
                     where a.business_id = $1 and r.run_id = $2 and a.step_id = $3
                       and a.id <> $4) as went_on`,
    [tx.businessId, row.run_id, row.step_id, row.attempt_id],
  );
  const resumes = outcome !== 'happened' && !row.absence_proved && later?.went_on !== true;
  return {
    attemptId: row.attempt_id,
    outcome,
    settlement: settledAt(BigInt(row.held_minor), BigInt(row.spent_minor)),
    resumed: resumes ? await resume(tx, { ...row, spent_minor: '0' }, false) : null,
  };
}

export interface OutcomeRequest {
  readonly taskId: string;
  readonly attemptId: string;
  readonly outcome: RecordedOutcome;
  readonly subjects: readonly Subject[];
  readonly collection: string;
  /** The recording person's actor, whom the clear of an agent from the task names. */
  readonly actorId: string;
}

export interface OutcomeRecorded {
  readonly attemptId: string;
  readonly outcome: RecordedOutcome;
  readonly settlement: Settlement;
  readonly resumed: string | null;
}

/**
 * A person's recorded outcome, under the step's locks with their covering
 * grants held, and `billing:decide` on the task judged again at the locked
 * instant. Only a step still held unknown takes one.
 */
export async function recordOutcome(
  tx: TenantQuery,
  request: OutcomeRequest,
): Promise<RuntimeResult<OutcomeRecorded>> {
  await holdCoveringGrants(tx, request.subjects, request.collection);
  // The step and any replacement the pass reserved for it, locked as one set:
  // a replacement dispatched between discovery and the locks is a changed
  // set, rolled back and asked again.
  const discover = async () => {
    const rows = await tx.query<Unknown>(
      `${UNKNOWN_SELECT} where att.business_id = $1 and att.id = $2 and run.task_id = $3`,
      [tx.businessId, request.attemptId, request.taskId],
    );
    const first = rows[0];
    return [rows, first === undefined ? [] : await discoverReplacements(tx, first)] as const;
  };
  const {
    found: [found, replacements],
  } = await lockRediscovered(tx, {
    discover,
    locks: ([rows, more]) => [...locksOf(rows), ...replacementLocks(more)],
    rule: 'exact',
    changed: 'outcome: the step changed under discovery; roll back and record it again',
  });
  const row = found[0];
  const decides = await checkAuthorityAt(
    tx,
    request.subjects,
    {
      collection: request.collection,
      action: 'decide',
      scope: { kind: 'record', id: request.taskId },
    },
    await lockedInstant(tx),
  );
  if (!decides.ok) {
    return refuse(
      'SCOPE_NOT_GRANTED',
      'no live grant to decide money on this task covers the outcome',
      'A person holding budget permission on this task records it.',
    );
  }
  const closed = row !== undefined && row.attempt_state !== 'liability_unknown';
  const wroteOff = closed && (await writtenOff(tx, row));
  if (row === undefined || (!wroteOff && (closed || row.reservation_state !== 'held'))) {
    return refuse(
      'LIABILITY_NOT_UNKNOWN',
      'this attempt is not held as an unknown liability',
      'Nothing was recorded. Read the task: its outcome is already settled or never was unknown.',
    );
  }
  // A replacement with a model call out owes that call: its hold stays until the call settles.
  if (request.outcome === 'happened' && replacements.some((one) => one.marked || one.calling)) {
    return refuse(
      'TRANSITION_NOT_PERMITTED',
      'the replacement for this step has already started, so the work ran again',
      'Nothing was recorded. Settle or reconcile the replacement, then record this attempt.',
    );
  }
  if (request.outcome === 'happened') {
    for (const one of replacements) {
      // Sequential: each moves the one envelope the step shares.
      // eslint-disable-next-line no-await-in-loop
      await stopReplacement(tx, one, row.attempt_id);
    }
  }
  if (wroteOff) return { ok: true, value: await afterWriteOff(tx, row, request.outcome) };
  const settlement =
    request.outcome === 'nothing_happened'
      ? await release(tx, row)
      : await settle(tx, row, BigInt(row.held_minor), NO_CALLS, 'completed');
  // AW-10: the step's held broker calls take the same outcome, with the person's name.
  const person = request.subjects.find((one) => one.kind === 'person');
  if (person !== undefined) {
    await resolveHeldCalls(tx, row.reservation_id, request.outcome, person.id);
  }
  const resumes = request.outcome !== 'happened' && !row.absence_proved;
  // Nothing happened: the step resumes on what its model calls left.
  const left =
    request.outcome === 'nothing_happened' && settlement.state === 'settled'
      ? { ...row, spent_minor: String(settlement.spentMinor) }
      : row;
  return {
    ok: true,
    value: {
      attemptId: row.attempt_id,
      outcome: request.outcome,
      settlement,
      resumed: resumes ? await resume(tx, left, false) : null,
    },
  };
}
