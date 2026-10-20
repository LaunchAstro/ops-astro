// SPDX-License-Identifier: AGPL-3.0-only
//
// The words sections 006 to 008 draw (MP-14-8), kept apart from the markup so
// each rule is one small function: the TTL countdown, the stamps, the cause of
// a grant taken back and the lede sentences.

import type { GrantView } from '../../../../../packages/core-wire/src/index.ts';
import { BUSINESS_CLOCK } from '../task/due-dates.ts';

export type Countdown = { readonly tone: 'plain' | 'warn' } & (
  { readonly minutesLeft: number } | { readonly words: string }
);

/**
 * What is left on a grant. A live grant with a minute or more to run is the
 * kit's countdown (DS-PRIM-25), in warning ink under an hour. Otherwise a word,
 * because the kit says "Expired" once its clock passes and whether a grant
 * ended is the read's to say: a grant the read calls live whose expiry this
 * clock has passed waits for the next re-read in warning ink, never "Ran out".
 */
export function countdownOf(grant: GrantView, now: number): Countdown {
  if (grant.state === 'taken_back') return { words: 'Taken back', tone: 'plain' };
  if (grant.state === 'ran_out') return { words: 'Ran out', tone: 'plain' };
  const left = Date.parse(grant.expiresAt) - now;
  if (left <= 0) return { words: 'Expiry passed, re-reading', tone: 'warn' };
  const minutesLeft = Math.floor(left / 60_000);
  if (minutesLeft < 1) return { words: 'Under 1 min left', tone: 'warn' };
  return { minutesLeft, tone: minutesLeft < 60 ? 'warn' : 'plain' };
}

export const stamp = (at: string): string =>
  new Date(at).toLocaleString('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: BUSINESS_CLOCK,
  });

export const clock = (at: string): string =>
  new Date(at).toLocaleTimeString('en-AU', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: BUSINESS_CLOCK,
  });

const CAUSE_WORDS: Readonly<Record<string, string>> = {
  authority_lost: 'the delegating person lost the authority',
  delegation_revoked: 'delegation revoked',
  work_retired: 'the work was retired',
};

export const causeOf = (cause: string | null): string =>
  cause === null ? 'no cause recorded' : (CAUSE_WORDS[cause] ?? cause.replaceAll('_', ' '));

export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/**
 * Null when there are no grants at all: the absence line says so once.
 * With only ended grants it says nothing is live.
 */
export function grantsLede(total: number, live: number, liveExec: number): string | null {
  if (total === 0) return null;
  if (live === 0) return 'No grants live that you can see.';
  // The read answers what the caller may see, which may be some clients only.
  const held = `${plural(live, 'grant')} live that you can see.`;
  if (liveExec === 0) return `${held} None of them carries execute access.`;
  return `${held} ${liveExec} of them ${liveExec === 1 ? 'carries' : 'carry'} execute access.`;
}

export function tripwiresLede(armed: number, cannotBeArmed: number): string {
  const counted = `${plural(armed, 'check')} armed`;
  return cannotBeArmed === 0 ? `${counted}.` : `${counted}, and ${cannotBeArmed} that cannot be.`;
}

const dayOf = (at: number): string =>
  new Date(at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * The round runs from 23:00 on the evening before `roundOn`, the date its
 * brief is handed over, to 08:10 that morning.
 */
export function nightLede(roundOn: string, notClean: number): string {
  const noon = Date.parse(`${roundOn}T12:00:00Z`);
  const window = `${dayOf(noon - 86_400_000)} 23:00 to ${dayOf(noon)} 08:10`;
  if (notClean === 0) return `${window}.`;
  return `${window}, and ${plural(notClean, 'step')} did not go cleanly.`;
}
