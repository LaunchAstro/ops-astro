// SPDX-License-Identifier: AGPL-3.0-only
//
// The budget wait (AW-05): the approved ceiling is the stop. When a call's
// priced maximum does not fit in what the run's reservation has left, the
// reserve refuses it and, in the same transaction, the run stops and asks.
//
// Under the reserve's locks, in the contract's order: the run's task, the run,
// the lease, the delegation and the reservation (`broker-facts.ts`). So two
// calls on one run reaching the ceiling at once ask once: the second waits on
// the run and then finds its lease over.
//
// One transition (S2, #438): the reserve's stop and pickup's stop at a spent
// hold (`core-runtime/src/budget-stop.ts`) both call `stopAtBudget`, so a run
// ends the same way whichever path saw the final unanswered ask.
//
// - The ask records the ceiling (the reservation's hold), the spend to date
//   (what the reservation has committed), the currency, and the decision that
//   approved the plan, so the question can be put in the terms approved. Its
//   place in the conversation where the plan was approved is AW-04's origin.
// - The rows are the persisted count. A run asks three times at most, and the
//   third ask is the consolidated decision (execution decisions 15.2). A stop
//   after it raises no fourth ask: the run ends (`cancelled`) and a person is
//   told on the task (`awaiting_person`, `needs_approval`).
// - Either way the lease ends and its delegation is retired, so nothing can
//   spend, and the attempt's outcome is `budget_wait / BUDGET_UNAVAILABLE`
//   (`broker-stop.ts`). A waiting run's reservation stays held: the approved ceiling is
//   reserved for the person's answer, and restart recovery leaves a waiting
//   run's hold alone (`core-runtime/src/recovery/classifier.ts`). An ended
//   run's hold is recovery's to settle at its calls' spend, as for any ended
//   lease and retired delegation.
// - The run is `waiting_budget`. Migration 0087 lets nothing take it out of
//   the wait; 0088 lets only a person's answer to the latest ask do so
//   (`core-runtime/src/budget-answer.ts`).

import { randomUUID } from 'node:crypto';
import { raiseAlert, type TenantQuery } from '../../core-records/src/index.ts';
import type { Facts } from './broker-facts.ts';
import { retireAttempt } from './broker-stop.ts';

/** The most asks one run may raise; the last is the consolidated decision. */
export const MAX_BUDGET_ASKS = 3;

/** What the reserve knows of the stop, from rows it holds locked. */
export interface BudgetStop {
  readonly runId: string;
  readonly leaseId: string;
  readonly delegationId: string | null;
  readonly reservationId: string;
  readonly versionId: string;
  readonly ceilingMinor: number;
  readonly spentMinor: number;
}

/** What the stop came to: the run waits on its ask, or its last ask was spent and it ended. */
export type BudgetStopped =
  | { readonly kind: 'waiting'; readonly askNumber: number; readonly consolidated: boolean }
  | { readonly kind: 'last_ask_exhausted' };

/**
 * The one budget-exhaustion transition, for the reserve and pickup alike. Under
 * the caller's locks on the run's task, the run, the lease, the delegation and
 * the reservation. The lease ends and its delegation is retired; within the
 * bound the run asks and waits, and past its consolidated ask it ends and a
 * person is told on the task.
 */
export async function stopAtBudget(tx: TenantQuery, stop: BudgetStop): Promise<BudgetStopped> {
  const [asked] = await tx.query<{ n: number }>(
    `select count(*)::int as n from public.budget_asks where business_id = $1 and run_id = $2`,
    [tx.businessId, stop.runId],
  );
  const askNumber = (asked?.n ?? 0) + 1;
  const asks = askNumber <= MAX_BUDGET_ASKS;
  const consolidated = askNumber === MAX_BUDGET_ASKS;
  if (asks) await insertAsk(tx, stop, askNumber, consolidated);
  // Both ends record the attempt's outcome here (#1623 R1): a stop past the
  // last ask ends the run, but the attempt stopped at its budget all the same.
  await retireAttempt(tx, stop, 'BUDGET_UNAVAILABLE');
  if (asks) {
    await tx.query(
      `update public.planned_runs set state = 'waiting_budget'
        where business_id = $1 and id = $2 and state = 'claimed'`,
      [tx.businessId, stop.runId],
    );
    return { kind: 'waiting', askNumber, consolidated };
  }
  const [run] = await tx.query<{ readonly task_id: string }>(
    `update public.planned_runs set state = 'cancelled'
      where business_id = $1 and id = $2 returning task_id`,
    [tx.businessId, stop.runId],
  );
  if (run === undefined) throw new Error('budget stop: the stopped run is gone');
  await raiseAlert(tx, {
    taskId: run.task_id,
    causeId: stop.reservationId,
    raised: { kind: 'awaiting_person', waitingReason: 'needs_approval' },
  });
  return { kind: 'last_ask_exhausted' };
}

/**
 * The ask, in the terms approved. The spend is what the reservation has
 * committed, never clamped: one past the ceiling is a defect the row's own
 * check refuses (0087), and the transaction goes back.
 */
async function insertAsk(
  tx: TenantQuery,
  stop: BudgetStop,
  askNumber: number,
  consolidated: boolean,
): Promise<void> {
  const inserted = await tx.query<{ id: string }>(
    `insert into public.budget_asks
       (business_id, id, run_id, reservation_id, lease_id, decision_id, ask_number, kind,
        ceiling_minor, spent_minor, currency)
     select $1, $2, $3, $4, $5, d.id, $6, $7, $8, $9, env.currency
       from public.reservations r
       join public.task_envelopes env on env.business_id = r.business_id and env.id = r.envelope_id
       join lateral (
         select id from public.gate_decisions
          where business_id = r.business_id and version_id = r.version_id and decision = 'approve'
          order by seq desc limit 1
       ) d on true
      where r.business_id = $1 and r.id = $4 and r.version_id = $10
     returning id`,
    [
      tx.businessId,
      randomUUID(),
      stop.runId,
      stop.reservationId,
      stop.leaseId,
      askNumber,
      consolidated ? 'consolidated' : 'stop',
      stop.ceilingMinor,
      stop.spentMinor,
      stop.versionId,
    ],
  );
  // A held reservation always stands on an approval (T2). One that does not is
  // this code's defect, and the transaction goes back with nothing ended.
  if (inserted.length !== 1) {
    throw new Error('budget wait: the reservation has no approving decision');
  }
}

/** AW-05's words at the stop: the run waits for a person, and nothing spends until they answer. */
const WAITING_WORDS =
  'The approved ceiling is reached. The run waits for a person to top it up or end it, and nothing spends until they answer.';
/** A stop after the consolidated decision asks no fourth time (execution decisions 15.2). */
const LAST_ASK_WORDS =
  "The consolidated decision was this run's last ask, so the run ends here and a person is told on the task.";

/** The reserve's stop: the run stops and asks or ends, and the refusal says which. Under the reserve's locks. */
export async function stopAtCeiling(
  tx: TenantQuery,
  facts: Facts,
  spentMinor: number,
): Promise<string> {
  const stopped = await stopAtBudget(tx, {
    runId: facts.runId,
    leaseId: facts.leaseId,
    delegationId: facts.delegationId,
    reservationId: facts.reservationId,
    versionId: facts.versionId,
    ceilingMinor: facts.heldMinor,
    spentMinor,
  });
  return stopWords(stopped);
}

/** What a stop tells the caller: the run waits for a person, or it ended at its last ask. */
export const stopWords = (stopped: BudgetStopped): string =>
  stopped.kind === 'waiting' ? WAITING_WORDS : LAST_ASK_WORDS;
