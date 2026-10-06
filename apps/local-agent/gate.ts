// SPDX-License-Identifier: AGPL-3.0-only
//
// What the runner checks before it spawns anything (LA-1): the model and the
// cap. The model Codex runs on this laptop runs by default; any
// other model needs the owner's yes, as does a cap above the default
// (settings.ts). The yes is a line in `approvals.json`, written by hand.

import { LOCAL_GPT_DEFAULT_MODEL } from '../../packages/core-connectors/src/index.ts';
import { ledgerTotal } from './ledger.ts';
import {
  DEFAULT_CAP_TOKENS,
  MAX_CAP_TOKENS,
  readApprovals,
  type Approvals,
  type RunnerSettings,
} from './settings.ts';

export const DEFAULT_MODEL: string = LOCAL_GPT_DEFAULT_MODEL;

/** What a call killed or unreadable is charged besides its prompt: its usage is unknown, never nothing. */
export const UNKNOWN_CALL_TOKENS = 50_000;

/**
 * What a call is charged before codex runs, and if it is killed or unreadable:
 * 50,000 and its prompt's UTF-8 bytes (a token is at least one byte). It is
 * let in only with this much left, so that charge never passes the cap.
 */
export const callNeed = (prompt: string): number =>
  UNKNOWN_CALL_TOKENS + Buffer.byteLength(prompt, 'utf8');

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
 * The cap in force. A cap the owner configured is the cap, but one above the
 * default holds only while approvals.json still names that figure: the yes
 * withdrawn, the default is the cap from the next call on. Unset, the owner's
 * yes on a raise is the cap from the next call on, never past MAX_CAP_TOKENS.
 */
export function capInForce(
  settings: GateSettings,
  approved: Approvals = readApprovals(settings.home),
): number {
  if (!settings.capConfigured) {
    return Math.min(approved.capTokens ?? settings.capTokens, MAX_CAP_TOKENS);
  }
  if (settings.capTokens > DEFAULT_CAP_TOKENS && approved.capTokens !== settings.capTokens) {
    return DEFAULT_CAP_TOKENS;
  }
  return settings.capTokens;
}

/** Checked in this order, every call, before anything is spawned; `need` is callNeed's. */
export function decide(settings: GateSettings, model: string, need: number): Decision {
  const approved = readApprovals(settings.home);
  if (model !== DEFAULT_MODEL && !approved.models.includes(model)) {
    return { ok: false, code: 'LOCAL_MODEL_NOT_APPROVED' };
  }
  const cap = capInForce(settings, approved);
  const left = cap - ledgerTotal(settings.home, cap);
  if (left < need) return { ok: false, code: 'LOCAL_CAP_REACHED' };
  return { ok: true, tokensLeft: left };
}
