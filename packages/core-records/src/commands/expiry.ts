// SPDX-License-Identifier: AGPL-3.0-only
//
// The expiry window every gate this surface opens is read through. Split out
// unchanged when the one task-runtime module was divided (thermo review
// b282216, H2).

/**
 * The longest a gate may stay open, and the window it stays open for when the
 * caller names none: seven days either way. The maximum is the owner's
 * decision (d) of 23 September 2026, "Fixed server maximum of seven days",
 * for new proposals and successor gates. Existing gates are not rewritten.
 */
export const MAXIMUM_EXPIRY_SECONDS: number = 7 * 24 * 60 * 60;
const DEFAULT_EXPIRY_SECONDS = MAXIMUM_EXPIRY_SECONDS;

/** The fix every expiry refusal gives, naming the maximum in the unit sent. */
export const EXPIRY_FIX: string = `Name a whole number of seconds from 1 to ${String(MAXIMUM_EXPIRY_SECONDS)} (seven days), or leave it out for seven days.`;

/**
 * A caller's `expiresInSeconds` as an instant on the server's clock, or
 * `undefined` when it is not a whole number of seconds from 1 to the maximum.
 * Absent is the default week. `task.propose`, `task.restart` and
 * `task.handback`'s successor all read their expiry through this one
 * function, so they are bounded the same way and cannot drift apart.
 */
export function expiryFrom(seconds: unknown): Date | undefined {
  const value = seconds ?? DEFAULT_EXPIRY_SECONDS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined;
  if (value > MAXIMUM_EXPIRY_SECONDS) return undefined;
  return new Date(Date.now() + value * 1000);
}
