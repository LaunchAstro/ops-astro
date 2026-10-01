// SPDX-License-Identifier: AGPL-3.0-only
//
// The words sections 006 to 008 draw (MP-14-8), kept apart from the markup so
// each rule is one small function: the TTL countdown, the stamps, the cause of
// a grant taken back and the lede sentences.

import type { GrantView } from '../../../../../packages/core-wire/src/index.ts';

const HOUR = 60;

export interface Countdown {
  readonly words: string;
  readonly tone: 'plain' | 'warn';
}

/**
 * What is left on a grant: "37m left" in warning ink under an hour, "5h 0m
 * left" otherwise, and a word once it has ended.
 */
export function countdownOf(grant: GrantView, now: number): Countdown {
  if (grant.state === 'taken_back') return { words: 'Taken back', tone: 'plain' };
  const minutes = Math.floor((Date.parse(grant.expiresAt) - now) / 60_000);
  if (grant.state === 'ran_out' || minutes <= 0) return { words: 'Ran out', tone: 'plain' };
  if (minutes < HOUR) return { words: `${minutes}m left`, tone: 'warn' };
  return { words: `${Math.floor(minutes / HOUR)}h ${minutes % HOUR}m left`, tone: 'plain' };
}

export const stamp = (at: string): string =>
  new Date(at).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });

export const clock = (at: string): string =>
  new Date(at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });

const CAUSE_WORDS: Readonly<Record<string, string>> = {
  authority_lost: 'the delegating person lost the authority',
  delegation_revoked: 'delegation revoked',
  work_retired: 'the work was retired',
};

export const causeOf = (cause: string | null): string =>
  cause === null ? 'no cause recorded' : (CAUSE_WORDS[cause] ?? cause.replaceAll('_', ' '));

export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

export function grantsLede(live: number, liveExec: number): string {
  const held = `${plural(live, 'lease')} live across the book.`;
  if (liveExec === 0) return `${held} None of them carries execute access.`;
  return `${held} ${liveExec} of them carry execute access; none can act until the executor is connected.`;
}

export function tripwiresLede(armed: number, cannotBeArmed: number): string {
  const counted = `${plural(armed, 'check')} armed`;
  return cannotBeArmed === 0 ? `${counted}.` : `${counted}, and ${cannotBeArmed} that cannot be.`;
}

export function nightLede(roundOn: string, notClean: number): string {
  const day = new Date(`${roundOn}T12:00:00Z`).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
  });
  const window = `${day} · 23:00 to 08:10`;
  if (notClean === 0) return `${window}.`;
  return `${window}, and ${plural(notClean, 'step')} did not go cleanly.`;
}
