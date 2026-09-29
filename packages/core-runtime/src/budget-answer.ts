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

import type { TenantQuery } from '../../core-records/src/index.ts';
import type { BudgetAnswerRequest, BudgetAnswerResult } from './budget-answer-facts.ts';

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

/** Signature only: the answers are not built yet. */
export async function topUpAtBudgetStop(
  _tx: TenantQuery,
  _request: TopUpRequest,
): Promise<BudgetAnswerResult<TopUpOutcome>> {
  throw new Error('topUpAtBudgetStop: not built');
}

/** Signature only: the answers are not built yet. */
export async function endAtBudgetStop(
  _tx: TenantQuery,
  _request: BudgetAnswerRequest,
): Promise<BudgetAnswerResult<EndOutcome>> {
  throw new Error('endAtBudgetStop: not built');
}
