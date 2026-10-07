// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's answers at the budget stop. A run waiting for budget (0087) leaves
// the wait only by a person's answer to its latest ask (0088):
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
// counts the spend once, as actual. A stop raised because the calls spent the
// whole hold (`budget-stop.ts`) has no hold left to raise: its top-up is the
// step's fresh hold (`holdTopUp`).

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import {
  deny,
  invalid,
  NOT_WAITING_FIX,
  openAnswer,
  type BudgetAnswerRequest,
  type BudgetAnswerResult,
  type Opened,
} from './budget-answer-facts.ts';
import { capCommitted, capVerdict } from './budget.ts';
import { reserve } from './decide.ts';
import {
  observedRefusal,
  openCallOn,
  recordedRefusal,
  releaseUncounted,
  releaseUnstarted,
  spentOn,
} from './budget-stop.ts';
import { giveBackReleased } from '../../core-custody/src/index.ts';
import { fourEyes, insertApproval } from './budget-answer-eyes.ts';
import { refuse } from './refusals.ts';

export interface BudgetStopTopUpRequest extends BudgetAnswerRequest {
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
  request: BudgetStopTopUpRequest,
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
  // Before the answer (with the hold's state, for the version room) marks a closed hold counted.
  if (CLOSED_STOPS.includes(opened.value.locked.reservation_state))
    await releaseUncounted(tx, opened.value.locked.reservation_id);
  const answerId = randomUUID();
  await tx.query(
    `insert into public.budget_answers
       (business_id, id, ask_id, run_id, kind, amount_minor, currency, threshold_minor,
        first_person_id, second_person_id, hold_state)
     values ($1, $2, $3, $4, 'top_up', $5, $6, $7, $8, $9, $10)`,
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
      opened.value.locked.reservation_state,
    ],
  );
  const heldMinor = await raiseHold(tx, request, opened.value);
  return { ok: true, value: { state: 'applied', answerId, heldMinor } };
}

/**
 * The task out of the trash, the plan still live, a hold to raise, the
 * currency the envelope's, and room in the cap.
 */
async function topUpRefusal(
  tx: TenantQuery,
  request: BudgetStopTopUpRequest,
  { locked }: Opened,
): Promise<BudgetAnswerResult<never> | null> {
  if (!locked.task_live) {
    return deny(
      'NOT_FOUND',
      'the task this run works on is in the trash, and a trashed task takes no top-up',
      'Restore the task to top it up, or end the work.',
    );
  }
  if (locked.lineage_state !== 'live' || locked.superseded) {
    return refuse(
      'LINEAGE_TERMINAL',
      'the plan behind this run was cancelled, rejected or superseded while it waited',
      'End the work instead. A terminal plan takes no top-up.',
    );
  }
  if (!['held', ...CLOSED_STOPS].includes(locked.reservation_state)) {
    return refuse(
      'TRANSITION_NOT_PERMITTED',
      'this run holds no reservation to raise',
      NOT_WAITING_FIX,
    );
  }
  if (CLOSED_STOPS.includes(locked.reservation_state) && (await openCallOn(tx, locked))) {
    return refuse(
      'TRANSITION_NOT_PERMITTED',
      "a call open on this run's stopped hold when a person closed it is still unresolved",
      'End the run instead; a top-up cannot count a call left open when a person closed the hold.',
    );
  }
  const recorded = await recordedRefusal(tx, locked);
  if (recorded !== null) return recorded;
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

/** The hold, the envelope and the run, under the locks: the answer row is already in. */
async function raiseHold(
  tx: TenantQuery,
  request: BudgetStopTopUpRequest,
  { locked }: Opened,
): Promise<number> {
  if (CLOSED_STOPS.includes(locked.reservation_state)) return await holdTopUp(tx, request, locked);
  const { spent, unsent } = await spentOn(tx, locked.reservation_id);
  let heldMinor = Number(locked.held_minor) + request.amountMinor - spent;
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
  // A call the sweep released since the count read it went back onto this hold.
  heldMinor += await giveBackReleased(tx, unsent);
  await tx.query(
    `update public.planned_runs set state = 'planned' where business_id = $1 and id = $2`,
    [tx.businessId, request.runId],
  );
  return heldMinor;
}

/**
 * The closed holds a stop can be raised on (`budget-stop.ts`): one its calls spent whole, or a
 * replacement's target the version had no room for, maybe closed at nothing. It stays closed.
 */
const CLOSED_STOPS: readonly string[] = ['actual', 'abandoned'];

/**
 * A stop raised on a closed hold (`CLOSED_STOPS`): the top-up is the step's
 * fresh hold, on the envelope raised by it, and the run goes back for its pickup. Under the cap and
 * envelope locks the answer holds; the cap was checked for the amount.
 */
async function holdTopUp(
  tx: TenantQuery,
  request: BudgetStopTopUpRequest,
  locked: Opened['locked'],
): Promise<number> {
  await tx.query(
    `update public.task_envelopes set maximum_minor = maximum_minor + $3
      where business_id = $1 and id = $2`,
    [tx.businessId, locked.envelope_id, request.amountMinor],
  );
  const [step] = await tx.query<{ readonly step_id: string }>(
    'select step_id from public.attempts where business_id = $1 and reservation_id = $2',
    [tx.businessId, locked.reservation_id],
  );
  if (step === undefined) throw new Error('budget top-up: the stopped hold has no attempt');
  const fresh = await reserve(tx, {
    envelopeId: locked.envelope_id,
    versionId: locked.version_id,
    runId: request.runId,
    stepId: step.step_id,
    heldMinor: request.amountMinor,
  });
  // The envelope was raised by the amount and the cap checked for it, under their locks.
  if (!fresh.ok)
    throw new Error(`budget top-up: the raised hold was refused ${fresh.refusal.code}`);
  await tx.query(
    `update public.planned_runs set state = 'planned' where business_id = $1 and id = $2`,
    [tx.businessId, request.runId],
  );
  return request.amountMinor;
}

/** End the work at the budget stop: one click, the hold released, the task parked. */
export async function endAtBudgetStop(
  tx: TenantQuery,
  request: BudgetAnswerRequest,
): Promise<BudgetAnswerResult<EndOutcome>> {
  const opened = await openAnswer(tx, request, 'gate');
  if (!opened.ok) return opened;
  const { person, locked } = opened.value;
  const refused = await observedRefusal(tx, locked.reservation_state, locked.reservation_id);
  if (refused !== null) return refused;
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
    const counted = await spentOn(tx, locked.reservation_id);
    spentMinor = counted.spent;
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
    // A call the sweep released since the count read it is spent no longer.
    const back = await giveBackReleased(tx, counted.unsent);
    spentMinor -= back;
    releasedMinor += back;
  }
  releasedMinor += await releaseUnstarted(tx, request.runId, locked, answerId);
  await tx.query(
    `update public.planned_runs set state = 'cancelled' where business_id = $1 and id = $2`,
    [tx.businessId, request.runId],
  );
  return { ok: true, value: { answerId, releasedMinor, spentMinor } };
}
