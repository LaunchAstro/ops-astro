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
// - The ask records the ceiling (the reservation's hold), the spend to date
//   (what the reservation has committed), the currency, and the decision that
//   approved the plan, so the question can be put in the terms approved. Its
//   place in the conversation where the plan was approved is AW-04's origin.
// - The rows are the persisted count. A run asks three times at most, and the
//   third ask is the consolidated decision (execution decisions 15.2); a stop
//   after it raises no fourth ask and is refused like any other call past the
//   ceiling.
// - The lease ends and its delegation is retired, so nothing can spend while
//   the run waits. The reservation stays held: the approved ceiling is
//   reserved for the person's answer, and restart recovery leaves a waiting
//   run's hold alone (`core-runtime/src/recovery/classifier.ts`).
// - The run is `waiting_budget`. Migration 0034 lets nothing take it out of
//   the wait: only a person's answer, which the next increment builds.

import { randomUUID } from 'node:crypto';
import { revokeDelegation, type TenantQuery } from '../../core-records/src/index.ts';
import type { Facts } from './broker-facts.ts';

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

export type BudgetWait =
  | { readonly raised: true; readonly askNumber: number; readonly consolidated: boolean }
  | { readonly raised: false };

/**
 * Stop the run at its ceiling and ask. Under the caller's locks on the run,
 * lease, delegation and reservation. A run past its third ask is not asked
 * again, and nothing is written.
 */
export async function raiseBudgetWait(tx: TenantQuery, stop: BudgetStop): Promise<BudgetWait> {
  const [asked] = await tx.query<{ n: number }>(
    `select count(*)::int as n from public.budget_asks where business_id = $1 and run_id = $2`,
    [tx.businessId, stop.runId],
  );
  const askNumber = (asked?.n ?? 0) + 1;
  if (askNumber > MAX_BUDGET_ASKS) return { raised: false };
  const consolidated = askNumber === MAX_BUDGET_ASKS;
  await insertAsk(tx, stop, askNumber, consolidated);
  await tx.query(
    `update public.leases set state = 'released', released_at = now()
      where business_id = $1 and id = $2 and state = 'live'`,
    [tx.businessId, stop.leaseId],
  );
  if (stop.delegationId !== null) await revokeDelegation(tx, stop.delegationId, 'work_retired');
  await tx.query(
    `update public.planned_runs set state = 'waiting_budget'
      where business_id = $1 and id = $2 and state = 'claimed'`,
    [tx.businessId, stop.runId],
  );
  return { raised: true, askNumber, consolidated };
}

/**
 * The ask, in the terms approved. The spend is what the reservation has
 * committed, never clamped: one past the ceiling is a defect the row's own
 * check refuses (0034), and the transaction goes back.
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
  "The approved ceiling is reached, and the consolidated decision was this run's last ask. Hand the work back.";

/** The reserve's stop: the run stops and asks, and the refusal says which. Under the reserve's locks. */
export async function stopAtCeiling(
  tx: TenantQuery,
  facts: Facts,
  spentMinor: number,
): Promise<string> {
  const wait = await raiseBudgetWait(tx, {
    runId: facts.runId,
    leaseId: facts.leaseId,
    delegationId: facts.delegationId,
    reservationId: facts.reservationId,
    versionId: facts.versionId,
    ceilingMinor: facts.heldMinor,
    spentMinor,
  });
  return wait.raised ? WAITING_WORDS : LAST_ASK_WORDS;
}
