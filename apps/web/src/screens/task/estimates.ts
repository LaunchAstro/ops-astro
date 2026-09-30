// SPDX-License-Identifier: AGPL-3.0-only
//
// The estimate's words (MP-4-8, CS-4.14). The server keeps whole minutes; the
// panel offers the mockup's vocabulary, and a day is eight hours, stated here
// once so the panel and the facts band read "1d" alike.

/** Minutes in a working day: a convention, not a fact, kept in one place. */
const DAY_MINUTES = 480;

/** The panel's choices, as the mockup offers them, in minutes. */
export const ESTIMATE_CHOICES: readonly number[] = [15, 30, 60, 120, 240, 480, 960];

/** An estimate in words: `2d` or `1d` on a whole day, else hours and minutes. */
export function estimateWords(minutes: number): string {
  if (minutes > 0 && minutes % DAY_MINUTES === 0) return `${minutes / DAY_MINUTES}d`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
