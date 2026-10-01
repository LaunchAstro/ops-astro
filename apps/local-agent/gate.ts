// SPDX-License-Identifier: AGPL-3.0-only
//
// What the runner checks before it spawns anything (LA-1, addendum 2): the
// model, the cap and the seat. Haiku runs by default; any other model needs
// the owner's yes, as does a cap above USD 10 (settings.ts). Until the inbox
// approval-gate item is wired, the yes is a line in `approvals.json` and the
// refusal is a plain message on the runner's own output.

import { readFileSync } from 'node:fs';
import { ledgerTotal } from './ledger.ts';
import { readApprovals, type RunnerSettings } from './settings.ts';

export const DEFAULT_MODEL = 'haiku';
/** The seat's stop: at or past it the runner refuses (the owner's 85% rule). */
export const SEAT_STOP_PERCENT = 85;

/** A model alias or id Claude Code takes: no spaces, no flags, nothing to split. */
export const MODEL_NAME: RegExp = /^[a-z0-9][a-z0-9.-]{0,63}$/u;

export type CallRefusal =
  'LOCAL_CAP_REACHED' | 'LOCAL_MODEL_NOT_APPROVED' | 'LOCAL_SEAT_OVER_STOP' | 'LOCAL_CLAUDE_FAILED';

/** The plain words for each refusal, for the runner's output and the person who reads it. */
export const REFUSAL_MESSAGES: Readonly<Record<CallRefusal, string>> = {
  LOCAL_CAP_REACHED:
    'The local agent has reached its API-equivalent cap. It needs the owner’s yes to raise it.',
  LOCAL_MODEL_NOT_APPROVED:
    'The local agent runs on Haiku. Another model needs the owner’s yes first.',
  LOCAL_SEAT_OVER_STOP: 'The Claude seat is at or past its 85% stop. Pick another seat or wait.',
  LOCAL_CLAUDE_FAILED: 'The local Claude Code call did not complete.',
};

/** The seat's reading, when the operator keeps one; past the stop for this seat refuses. */
function seatOverStop(settings: RunnerSettings): boolean {
  if (settings.usageFile === null) return false;
  let reading: unknown;
  try {
    reading = JSON.parse(readFileSync(settings.usageFile, 'utf8'));
  } catch {
    return false;
  }
  if (reading === null || typeof reading !== 'object') return false;
  const shape = reading as Record<string, unknown>;
  const percent = shape['percent'];
  return shape['seat'] === settings.seat && typeof percent === 'number'
    ? percent >= SEAT_STOP_PERCENT
    : false;
}

export type Decision =
  | { readonly ok: true; readonly budgetLeftUsd: number }
  | { readonly ok: false; readonly code: CallRefusal };

/** Checked in this order, every call, before anything is spawned. */
export function decide(settings: RunnerSettings, model: string): Decision {
  if (model !== DEFAULT_MODEL && !readApprovals(settings.home).models.includes(model)) {
    return { ok: false, code: 'LOCAL_MODEL_NOT_APPROVED' };
  }
  const left = settings.capUsd - ledgerTotal(settings.home, settings.capUsd);
  if (left <= 0) return { ok: false, code: 'LOCAL_CAP_REACHED' };
  if (seatOverStop(settings)) return { ok: false, code: 'LOCAL_SEAT_OVER_STOP' };
  return { ok: true, budgetLeftUsd: left };
}
