// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's answers at the budget stop. A run waiting for budget (0034) leaves
// the wait only by a person's answer to its latest ask (0035):
//
// - **The top-up** (`billing:decide`, a person). It raises the approved
//   ceiling within the business cap, and the run goes back to `planned` for a
//   fresh pickup. The plan approver answers where they still hold the
//   permission, otherwise any holder. Above the business's four-eyes
//   threshold one person is not enough: the first approval is recorded and
//   applies nothing, and a second, distinct holder approving the same top-up
//   completes it (T2e's stored setting, read here, never restated).
// - **The end** (`gate:decide`, a person). One click, no confirmation (U7):
//   the run ends, the unspent hold is released and the spend to date stays
//   counted. The task is parked for a person: nothing here writes it.
//
// Both decide on facts read under the run's locks (`budget-answer-facts.ts`),
// the threshold, cap and currency included. Every write is in the caller's
// one transaction, so a failure at any step applies nothing.
//
// **The spend to date moves to the envelope's actual at a top-up.** Pickup's
// replacement re-holds the old reservation's `held_minor` on a fresh
// reservation with no calls on it, so the hold is set to the raised ceiling
// less what is spent: the run may spend the raised ceiling once, and the cap
// counts the spend once, as actual.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import {
  approvalsOf,
  approverHolds,
  deny,
  invalid,
  NOT_WAITING_FIX,
  openAnswer,
  spentOn,
  thresholdOf,
  type Approval,
  type BudgetAnswerRequest,
  type BudgetAnswerResult,
  type Opened,
} from './budget-answer-facts.ts';
import { capCommitted, capVerdict } from './budget.ts';
import { refuse } from './refusals.ts';

export interface TopUpRequest extends BudgetAnswerRequest {
  /** In the currency's minor units, a whole number above zero. */
  readonly amountMinor: number;
  readonly currency: string;
}

export type TopUpOutcome =
  | { readonly state: 'applied'; readonly answerId: string; readonly heldMinor: number }
  | {
      readonly state: 'awaiting_second';
      readonly approvalId: string;
      readonly thresholdMinor: number;
    };

export interface EndOutcome {
  readonly answerId: string;
  readonly releasedMinor: number;
  readonly spentMinor: number;
}

/** Top up a stopped run's approved ceiling, under four eyes above the threshold. */
export async function topUpAtBudgetStop(
  tx: TenantQuery,
  request: TopUpRequest,
): Promise<BudgetAnswerResult<TopUpOutcome>> {
  if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0) {
    return invalid('amountMinor', 'Send the top-up as a whole number of minor units above zero.');
  }
  if (!/^[A-Z]{3}$/u.test(request.currency)) {
    return invalid('currency', 'Send the currency as its three-letter code.');
  }
  const opened = await openAnswer(tx, request, 'billing');
  if (!opened.ok) return opened;
  const refused = await topUpRefusal(tx, request, opened.value);
  if (refused !== null) return refused;
  const eyes = await fourEyes(tx, request, opened.value);
  if (!eyes.ok) return eyes;
  const { threshold, other, mine, completing } = eyes.value;

  const approvalId = mine?.id ?? (await insertApproval(tx, request, opened.value));
  if (!completing && threshold !== null) {
    return {
      ok: true,
      value: { state: 'awaiting_second', approvalId, thresholdMinor: threshold.minor },
    };
  }
  const answerId = randomUUID();
  await tx.query(
    `insert into public.budget_answers
       (business_id, id, ask_id, run_id, kind, amount_minor, currency, threshold_minor,
        first_person_id, second_person_id)
     values ($1, $2, $3, $4, 'top_up', $5, $6, $7, $8, $9)`,
    [
      tx.businessId,
      answerId,
      opened.value.locked.ask_id,
      request.runId,
      request.amountMinor,
      request.currency,
      threshold?.minor ?? null,
      other?.person_id ?? opened.value.person.personId,
      other === undefined ? null : opened.value.person.personId,
    ],
  );
  const heldMinor = await raiseHold(tx, request, opened.value);
  return { ok: true, value: { state: 'applied', answerId, heldMinor } };
}

/** The plan still live, a hold to raise, the currency the envelope's, and room in the cap. */
async function topUpRefusal(
  tx: TenantQuery,
  request: TopUpRequest,
  { locked }: Opened,
): Promise<BudgetAnswerResult<never> | null> {
  if (locked.lineage_state !== 'live' || locked.superseded) {
    return refuse(
      'LINEAGE_TERMINAL',
      'the plan behind this run was cancelled, rejected or superseded while it waited',
      'End the work instead. A terminal plan takes no top-up.',
    );
  }
  if (locked.reservation_state !== 'held') {
    return refuse(
      'TRANSITION_NOT_PERMITTED',
      'this run holds no reservation to raise',
      NOT_WAITING_FIX,
    );
  }
  if (request.currency !== locked.currency) {
    return refuse(
      'CAP_BINDING_MISMATCH',
      `this run's envelope is in ${locked.currency} and the top-up is in ${request.currency}`,
      'Top up in the currency the envelope and its cap hold.',
    );
  }
  return capVerdict({
    cap: await capCommitted(tx, locked.cap_id),
    capId: locked.cap_id,
    wanted: BigInt(request.amountMinor),
    currency: locked.currency,
  });
}

interface Eyes {
  readonly threshold: { readonly minor: number; readonly words: string } | null;
  readonly other: Approval | undefined;
  readonly mine: Approval | undefined;
  readonly completing: boolean;
}

/**
 * Who has approved, and whether this approval completes the top-up. Above the
 * threshold it takes two distinct people approving the same amount; the plan
 * approver is one of them where they hold the permission.
 */
async function fourEyes(
  tx: TenantQuery,
  request: TopUpRequest,
  opened: Opened,
): Promise<BudgetAnswerResult<Eyes>> {
  const threshold = await thresholdOf(tx, opened.locked.currency);
  const needsTwo = threshold !== null && request.amountMinor > threshold.minor;
  const pending = await approvalsOf(tx, opened.locked.ask_id);
  const mine = pending.find((row) => row.person_id === opened.person.personId);
  const other = pending.find((row) => row.person_id !== opened.person.personId);
  if (
    other !== undefined &&
    (other.amount_minor !== String(request.amountMinor) || other.currency !== request.currency)
  ) {
    return invalid(
      'amountMinor',
      `A top-up of ${other.amount_minor} ${other.currency} is already approved and waits for a second person; approve that amount, or end the work.`,
    );
  }
  if (needsTwo && other === undefined && mine !== undefined) {
    return deny(
      'FOUR_EYES_REQUIRED',
      `a top-up above the four-eyes threshold of ${threshold.words} needs a second person, and you have approved it already`,
      'Another person holding billing:decide approves the same top-up.',
    );
  }
  const completing = !needsTwo || other !== undefined;
  const approver = await approverHolds(tx, opened);
  const approvers = new Set([opened.person.personId, ...(needsTwo ? [other?.person_id] : [])]);
  if (approver !== null && completing && !approvers.has(approver)) {
    return refuse(
      'SCOPE_NOT_GRANTED',
      'the plan approver still holds billing:decide, so the plan approver approves this top-up',
      'Ask the person who approved the plan.',
    );
  }
  return { ok: true, value: { threshold, other, mine, completing } };
}

async function insertApproval(
  tx: TenantQuery,
  request: TopUpRequest,
  { locked, person }: Opened,
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into public.budget_approvals
       (business_id, id, ask_id, run_id, person_id, actor_id, amount_minor, currency)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      tx.businessId,
      id,
      locked.ask_id,
      request.runId,
      person.personId,
      person.actorId,
      request.amountMinor,
      request.currency,
    ],
  );
  return id;
}

/** The hold, the envelope and the run, under the locks: the answer row is already in. */
async function raiseHold(
  tx: TenantQuery,
  request: TopUpRequest,
  { locked }: Opened,
): Promise<number> {
  const spent = await spentOn(tx, locked.reservation_id);
  const heldMinor = Number(locked.held_minor) + request.amountMinor - spent;
  await tx.query(
    `update public.reservations set held_minor = $3 where business_id = $1 and id = $2`,
    [tx.businessId, locked.reservation_id, heldMinor],
  );
  await tx.query(
    `update public.task_envelopes
        set maximum_minor = maximum_minor + $3, held_minor = held_minor + $3 - $4,
            actual_minor = actual_minor + $4
      where business_id = $1 and id = $2`,
    [tx.businessId, locked.envelope_id, request.amountMinor, spent],
  );
  await tx.query(
    `update public.planned_runs set state = 'planned' where business_id = $1 and id = $2`,
    [tx.businessId, request.runId],
  );
  return heldMinor;
}

/** End the work at the budget stop: one click, the hold released, the task parked. */
export async function endAtBudgetStop(
  tx: TenantQuery,
  request: BudgetAnswerRequest,
): Promise<BudgetAnswerResult<EndOutcome>> {
  const opened = await openAnswer(tx, request, 'gate');
  if (!opened.ok) return opened;
  const { person, locked } = opened.value;
  const answerId = randomUUID();
  await tx.query(
    `insert into public.budget_answers (business_id, id, ask_id, run_id, kind, first_person_id)
     values ($1, $2, $3, $4, 'end', $5)`,
    [tx.businessId, answerId, locked.ask_id, request.runId, person.personId],
  );
  // A hold a lineage cancel already classified is not released twice.
  let releasedMinor = 0;
  let spentMinor = 0;
  if (locked.reservation_state === 'held') {
    spentMinor = await spentOn(tx, locked.reservation_id);
    releasedMinor = Number(locked.held_minor) - spentMinor;
    await tx.query(
      `update public.reservations
          set state = 'abandoned', classified_cause = 'budget_stop_ended',
              classified_cause_id = $3, terminal_at = now()
        where business_id = $1 and id = $2`,
      [tx.businessId, locked.reservation_id, answerId],
    );
    await tx.query(
      `update public.task_envelopes
          set held_minor = held_minor - $3, actual_minor = actual_minor + $4
        where business_id = $1 and id = $2`,
      [tx.businessId, locked.envelope_id, locked.held_minor, spentMinor],
    );
  }
  await tx.query(
    `update public.planned_runs set state = 'cancelled' where business_id = $1 and id = $2`,
    [tx.businessId, request.runId],
  );
  return { ok: true, value: { answerId, releasedMinor, spentMinor } };
}
