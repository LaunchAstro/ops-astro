// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared-account guard: the ChatGPT plan's account is also the
// reviewer's, so GPT in the chat stops at 95% of the account's week, leaving
// the rest. It is read from the plan's own report (`account/rateLimits/read`)
// before any thread is started. The weekly window is the one that lasts a
// week, whichever of the two the report gives first. The plan's permission for
// ordinary use must be given outright: absent or null is not given, and a
// percentage never stands in for it. The 5-hour window is Codex's own stop.

import type { Refused } from './gate.ts';

/** The share of the week the chat may use, in percent. */
export const WEEK_STOP_PERCENT = 95;

/** A week, in minutes: the weekly window lasts at least this long. */
const WEEK_MINUTES = 7 * 24 * 60;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Why the plan's reading stops the call, or null when it may go on. */
export function usageRefusal(reading: Record<string, unknown> | undefined): Refused | null {
  const snapshot = record(reading?.['rateLimits']);
  const permission = reading?.['ordinaryUsageAllowed'];
  if (typeof snapshot?.['rateLimitReachedType'] === 'string' || permission === false) {
    return { refused: 'LOCAL_PLAN_LIMIT' };
  }
  if (permission !== true) return { refused: 'GPT_USAGE_UNKNOWN' };
  const weekly = [snapshot?.['primary'], snapshot?.['secondary']]
    .map((window) => record(window))
    .find(
      (window) =>
        whole(window?.['windowDurationMins']) &&
        Number(window?.['windowDurationMins']) >= WEEK_MINUTES,
    );
  const used = weekly?.['usedPercent'];
  if (!whole(used)) return { refused: 'GPT_USAGE_UNKNOWN' };
  if (used < WEEK_STOP_PERCENT) return null;
  const resetsAt = weekly?.['resetsAt'];
  return whole(resetsAt)
    ? { refused: 'GPT_WEEK_RESERVED', resetsAt }
    : { refused: 'GPT_WEEK_RESERVED' };
}
