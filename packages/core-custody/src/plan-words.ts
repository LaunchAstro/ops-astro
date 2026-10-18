// SPDX-License-Identifier: AGPL-3.0-only
//
// The named results of a call on the owner's ChatGPT plan (#1620 P3), with
// words a task can show: the holder's own refusals from `prepare()`, and the
// endings of the plan's answer (`plan-answer.ts`). The words name no token,
// account or answer text.

import type { PlanRefusal } from './plan-token.ts';

export type PlanCode =
  | PlanRefusal
  | 'SUBSCRIPTION_PLAN_ALLOWANCE'
  | 'SUBSCRIPTION_NOT_ELIGIBLE'
  | 'SUBSCRIPTION_UNSUPPORTED_CAPABILITY'
  | 'SUBSCRIPTION_PLAN_UNAVAILABLE'
  | 'SUBSCRIPTION_ANSWER_WITHHELD';
export type PlanResult =
  | { readonly ok: true; readonly response: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly code: PlanCode; readonly words: string };

/** Words a task can show for each named result. */
export const PLAN_WORDS: Readonly<Record<PlanCode, string>> = {
  SUBSCRIPTION_SIGN_IN_NEEDED: 'The ChatGPT plan on the M5 needs the owner to sign in again.',
  SUBSCRIPTION_REFRESH_FAILED:
    'The ChatGPT plan’s sign-in could not be renewed in time. Nothing was sent; restart the task.',
  SUBSCRIPTION_STORE_FAILED:
    'Custody could not keep the ChatGPT plan’s sign-in safely on the M5. Nothing was sent.',
  SUBSCRIPTION_TOKEN_FILE_OPEN:
    'The ChatGPT plan’s token file on the M5 is open to other users, so custody will not use it. Nothing was sent.',
  SUBSCRIPTION_PLAN_ALLOWANCE:
    'The ChatGPT plan has reached its usage allowance. Nothing was retried; restart the task once it resets.',
  SUBSCRIPTION_NOT_ELIGIBLE:
    'The ChatGPT plan refused this account or workspace. Nothing was retried.',
  SUBSCRIPTION_UNSUPPORTED_CAPABILITY:
    'The ChatGPT plan does not support what this call asked for. Nothing was retried.',
  SUBSCRIPTION_PLAN_UNAVAILABLE:
    'The ChatGPT plan is unavailable just now. Nothing was retried; the owner can restart the task.',
  SUBSCRIPTION_ANSWER_WITHHELD:
    'The ChatGPT plan’s call did not end in a clean answer, so custody withheld what came back. Nothing was retried.',
};

/** A holder's refusal from `prepare()`, as the caller is told it. */
export const planRefused = (code: PlanCode): PlanResult => ({
  ok: false,
  code,
  words: PLAN_WORDS[code],
});
