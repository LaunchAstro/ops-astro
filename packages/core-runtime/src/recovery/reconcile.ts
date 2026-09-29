// SPDX-License-Identifier: AGPL-3.0-only
//
// T3d1: the reconciliation phase of the one pass T3b built (`sweep.ts`). No
// second pass.
//
// **Did it happen? The register answers.** A step the sweep held
// `liability_unknown` (dispatched, never confirmed, its lease no longer live)
// is asked about under its step lock, the lock the effect's own write takes
// (`tasks-comment.ts`). An effect committing meanwhile is waited for and then
// seen, and one arriving after is refused, because the attempt is no longer
// `dispatched`: that refusal is the old identity's fence.
//
// - Present: settled once, at the book's price for the one effect the
//   register holds (`price-book.ts`), never above the hold. The only machine
//   settlement, and only on observed proof.
// - Absent: the old hold stays held, whole, for a person (O6), marked
//   `absence_proved_at` in the same answer (0037), the old worker's
//   delegation revoked, and the step resumes as a new attempt on its own
//   hold, with its own identity. The replacement dispatches through T2c1's
//   recheck like any other work.
// - No answer: nothing is written; the step waits for a person.
//
// A person's recorded outcome is `outcome.ts`, beside this.

import { revokeDelegation } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { settleAtObserved, type Settlement } from '../budget.ts';
import { reserve } from '../decide.ts';
import type { LockRequest } from '../locks.ts';
import { priceAttempt } from '../price-book.ts';
import { lockRediscovered } from '../rediscovery.ts';

/** The register's answer for one unknown step: true, false, or `undefined` when it cannot answer. */
export type EffectLookup = (
  tx: TenantQuery,
  step: { readonly attemptId: string; readonly holderActorId: string; readonly stepKind: string },
) => Promise<boolean | undefined>;

export interface Reconciled {
  readonly attemptId: string;
  readonly answer: 'present' | 'absent' | 'unanswered';
  readonly reason: string;
}

export interface Unknown {
  readonly attempt_id: string;
  readonly reservation_id: string;
  readonly envelope_id: string;
  readonly cap_id: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly step_id: string;
  readonly lineage_id: string;
  readonly version_id: string;
  readonly lease_id: string | null;
  readonly delegation_id: string | null;
  readonly holder_actor_id: string | null;
  readonly step_kind: string;
  readonly held_minor: string;
  readonly price_book: string;
  readonly currency: string;
  readonly attempt_state: string;
  readonly reservation_state: string;
  readonly absence_proved: boolean;
  readonly approval_current: boolean;
}

export const UNKNOWN_SELECT = `select att.id as attempt_id, res.id as reservation_id, res.envelope_id, env.cap_id,
            run.task_id, run.id as run_id, att.step_id, run.lineage_id, res.version_id,
            l.id as lease_id, l.delegation_id, l.holder_actor_id, step.kind as step_kind,
            res.held_minor::text as held_minor, att.price_book, env.currency,
            att.state as attempt_state, res.state as reservation_state,
            (res.absence_proved_at is not null) as absence_proved,
            (g.state = 'approved' and ver.superseded_at is null and lin.state = 'live')
              as approval_current
       from public.attempts att
       join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
       join public.task_envelopes env on env.business_id = res.business_id and env.id = res.envelope_id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.planned_steps step on step.business_id = att.business_id and step.id = att.step_id
       join public.proposal_versions ver on ver.business_id = res.business_id and ver.id = res.version_id
       join public.gates g on g.business_id = res.business_id and g.version_id = res.version_id
       join public.proposal_lineages lin on lin.business_id = res.business_id and lin.id = run.lineage_id
       left join public.leases l on l.business_id = res.business_id and l.id = res.lease_id`;

/**
 * Unknown steps the pass may ask about, in this business only: marked, never
 * observed by their worker (an observed cost above its hold is a person's,
 * T2d), still held, not already answered, and with no live lease behind them.
 */
async function discoverUnknown(tx: TenantQuery): Promise<readonly Unknown[]> {
  return await tx.query<Unknown>(
    `${UNKNOWN_SELECT}
      where att.business_id = $1 and att.state = 'liability_unknown'
        and att.dispatch_marker and not att.observed
        and res.state = 'held' and res.absence_proved_at is null
        and (l.id is null or l.state <> 'live')
      order by att.id`,
    [tx.businessId],
  );
}

export function locksOf(rows: readonly Unknown[]): readonly LockRequest[] {
  return rows.flatMap((row): LockRequest[] => [
    { lockClass: 'cap', id: row.cap_id },
    { lockClass: 'envelope', id: row.envelope_id },
    { lockClass: 'task', id: row.task_id },
    { lockClass: 'run', id: row.run_id },
    { lockClass: 'step', id: row.step_id },
    { lockClass: 'lineage', id: row.lineage_id },
    ...(row.lease_id === null ? [] : [{ lockClass: 'lease' as const, id: row.lease_id }]),
    ...(row.delegation_id === null
      ? []
      : [{ lockClass: 'delegation' as const, id: row.delegation_id }]),
    { lockClass: 'reservation', id: row.reservation_id },
  ]);
}

/**
 * The reconciliation phase, in the caller's transaction on the tenancy
 * connection. Discover, lock, rediscover (`covered`: a step answered by a
 * concurrent pass drops out, which is why a duplicated wake-up does nothing),
 * then ask the register about each step in turn under its locks.
 */
export async function reconcileUnknown(
  tx: TenantQuery,
  lookup: EffectLookup,
): Promise<readonly Reconciled[]> {
  const { found } = await lockRediscovered(tx, {
    discover: async () => await discoverUnknown(tx),
    locks: locksOf,
    rule: 'covered',
    changed:
      'reconcile: the unknown set changed under discovery; roll back and reconcile on the next pass',
  });
  const answered: Reconciled[] = [];
  for (const row of found) {
    // Sequential: each answer moves the envelope the next may share.
    // eslint-disable-next-line no-await-in-loop
    answered.push(await answer(tx, row, lookup));
  }
  return answered;
}

async function answer(tx: TenantQuery, row: Unknown, lookup: EffectLookup): Promise<Reconciled> {
  const attemptId = row.attempt_id;
  const present =
    row.holder_actor_id === null
      ? undefined
      : await lookup(tx, {
          attemptId,
          holderActorId: row.holder_actor_id,
          stepKind: row.step_kind,
        });
  if (present === undefined) {
    return {
      attemptId,
      answer: 'unanswered',
      reason: 'the register cannot answer for this step; it waits for a person',
    };
  }
  if (!present) {
    const resumed = await resume(tx, row, true);
    return { attemptId, answer: 'absent', reason: resumed };
  }
  const cost = priceAttempt(
    { priceBook: row.price_book, currency: row.currency },
    { item: row.step_kind, quantity: 1 },
  );
  if (cost === undefined || cost > BigInt(row.held_minor)) {
    return {
      attemptId,
      answer: 'unanswered',
      reason:
        'the effect happened and the book cannot price it within the hold; a person records it',
    };
  }
  await tx.query(
    `update public.attempts set observed = true where business_id = $1 and id = $2 and dispatch_marker`,
    [tx.businessId, attemptId],
  );
  await settle(tx, row, cost, 'completed');
  return { attemptId, answer: 'present', reason: `settled once at ${cost.toString()} by the book` };
}

export const settle = async (
  tx: TenantQuery,
  row: Unknown,
  costMinor: bigint,
  outcome: 'completed',
): Promise<Settlement> =>
  await settleAtObserved(tx, {
    taskId: row.task_id,
    attemptId: row.attempt_id,
    reservationId: row.reservation_id,
    envelopeId: row.envelope_id,
    heldMinor: BigInt(row.held_minor),
    costMinor,
    outcome,
  });

/**
 * The step again, as a new attempt on its own hold, on the still-approved
 * version. `keep` marks the old hold absence-proved first, so it stays held
 * beside the replacement (0037); a hold a person has just settled needs no
 * mark. A replacement the envelope or cap has no room for, or whose approval
 * moved, is not reserved, and the step keeps its stop (the savepoint takes the
 * mark back with it, so the next pass asks again).
 */
export async function resume(tx: TenantQuery, row: Unknown, keep: boolean): Promise<string> {
  if (!row.approval_current) return 'not resumed: the approval behind it is no longer current';
  await tx.query('savepoint t3d1_resume');
  if (keep) {
    await tx.query(
      `update public.reservations set absence_proved_at = now()
        where business_id = $1 and id = $2 and absence_proved_at is null`,
      [tx.businessId, row.reservation_id],
    );
  }
  const replaced = await reserve(tx, {
    envelopeId: row.envelope_id,
    versionId: row.version_id,
    runId: row.run_id,
    stepId: row.step_id,
    heldMinor: BigInt(row.held_minor),
  });
  if (!replaced.ok) {
    await tx.query('rollback to savepoint t3d1_resume');
    return `not resumed: ${replaced.refusal.code}`;
  }
  await tx.query('release savepoint t3d1_resume');
  // The old identity's fence: its attempt is no longer `dispatched`, and the
  // delegation its worker held is revoked, as `retireWork` retires superseded
  // work, so a worker woken now is refused and the purpose is free for the
  // replacement's pickup.
  if (row.delegation_id !== null) await revokeDelegation(tx, row.delegation_id, 'work_retired');
  return `resumed as attempt ${replaced.value.attemptId}; the old identity is fenced`;
}
