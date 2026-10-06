// SPDX-License-Identifier: AGPL-3.0-only
//
// What the runner checks before it spawns anything (LA-1): the model and the
// cap. GPT-6.1-Sol, the model Codex runs on this laptop, runs by default; any
// other model needs the owner's yes, as does a cap above the default
// (settings.ts). The yes is a line in `approvals.json`, written by hand.

import { LOCAL_GPT_DEFAULT_MODEL } from '../../packages/core-connectors/src/index.ts';
import { ledgerTotal } from './ledger.ts';
import { MAX_CAP_TOKENS, readApprovals, type Approvals, type RunnerSettings } from './settings.ts';

export const DEFAULT_MODEL: string = LOCAL_GPT_DEFAULT_MODEL;

/** A call needs this much left under the cap: one call reads about 11,000 tokens of instructions. */
export const MIN_CALL_TOKENS = 20_000;

/** What a call killed or unreadable is charged: its usage is unknown, so never nothing. */
export const UNKNOWN_CALL_TOKENS = 50_000;

export type CallRefusal =
  'LOCAL_CAP_REACHED' | 'LOCAL_MODEL_NOT_APPROVED' | 'LOCAL_PLAN_LIMIT' | 'LOCAL_GPT_FAILED';

/** The plain words for each refusal, for the runner's output and the person who reads it. */
export const REFUSAL_MESSAGES: Readonly<Record<CallRefusal, string>> = {
  LOCAL_CAP_REACHED:
    'The local agent has reached its token cap. It needs the owner’s yes to raise it.',
  LOCAL_MODEL_NOT_APPROVED: `The local agent runs on ${DEFAULT_MODEL}. Another model needs the owner’s yes first.`,
  LOCAL_PLAN_LIMIT: 'The ChatGPT plan is at its usage limit. Wait for it to reset.',
  LOCAL_GPT_FAILED: 'The local codex call did not complete.',
};

export type GateSettings = Pick<RunnerSettings, 'home' | 'capTokens' | 'capConfigured'>;

export type Decision =
  | { readonly ok: true; readonly tokensLeft: number }
  | { readonly ok: false; readonly code: CallRefusal };

/**
 * The cap in force. A cap the owner configured is the cap. Unset, the owner's
 * yes on a raise is the cap from the next call on, never past MAX_CAP_TOKENS.
 */
export function capInForce(
  settings: GateSettings,
  approved: Approvals = readApprovals(settings.home),
): number {
  return settings.capConfigured
    ? settings.capTokens
    : Math.min(approved.capTokens ?? settings.capTokens, MAX_CAP_TOKENS);
}

/** Checked in this order, every call, before anything is spawned. */
export function decide(settings: GateSettings, model: string): Decision {
  const approved = readApprovals(settings.home);
  if (model !== DEFAULT_MODEL && !approved.models.includes(model)) {
    return { ok: false, code: 'LOCAL_MODEL_NOT_APPROVED' };
  }
  const cap = capInForce(settings, approved);
  const left = cap - ledgerTotal(settings.home, cap);
  if (left < MIN_CALL_TOKENS) return { ok: false, code: 'LOCAL_CAP_REACHED' };
  return { ok: true, tokensLeft: left };
}
