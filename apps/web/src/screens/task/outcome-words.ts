// SPDX-License-Identifier: AGPL-3.0-only
//
// #1719 (R10): what a run's stop means, in plain words, from one explicit
// table keyed by every outcome of the run outcome contract (#1623 R1,
// `RUN_OUTCOMES`), so a new outcome fails the type check until it has words
// here. The words are drawn from the stop the execution read carries, which
// the stop's own transaction stored, so they read the same after a restart of
// the API. One end code has words of its own: the plan asking its owner to
// sign in again (`SUBSCRIPTION_SIGN_IN_NEEDED`, research R1 section 3), which
// the contract files under `cancelled`.

import type { RunOutcome, RunOutcomeView } from '../../../../../packages/core-wire/src/index.ts';

export const OUTCOME_WORDS: { readonly [Outcome in RunOutcome]: string } = {
  success: 'The agent finished this work.',
  budget_wait: 'The agent stopped: this work’s budget is used up. Raise it, then restart.',
  call_limit: 'The agent stopped: it made as many model calls as this work allows.',
  cancelled: 'The agent’s work was stopped before it finished.',
  lease_lost: 'The agent lost its hold on this work before it finished.',
  unknown_provider_outcome:
    'The agent stopped without knowing whether its last model call went through. Check before you restart.',
  waiting_plan_allowance: 'The agent is waiting for the plan’s usage allowance to come back.',
  plan_unavailable: 'The agent stopped: the plan could not be reached.',
};

export const SIGN_IN_WORDS = 'The agent stopped: sign in to the plan again, then restart.';

/** A stop's words: the sign-in's own, or its outcome's. */
export function outcomeWords(stop: RunOutcomeView): string {
  if (stop.endCode === 'SUBSCRIPTION_SIGN_IN_NEEDED') return SIGN_IN_WORDS;
  return OUTCOME_WORDS[stop.outcome] ?? `The agent stopped (${String(stop.outcome)}).`;
}

/** Whether a person may ask for the work again: every stop but a finish. */
export const restartable = (stop: RunOutcomeView): boolean => stop.outcome !== 'success';
