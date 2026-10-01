// SPDX-License-Identifier: AGPL-3.0-only
//
// Calendar days for the due date picker (MP-4-8, CS-4.13), as `YYYY-MM-DD`.
//
// **One clock.** Today is the business's day, read on the clock the task
// screens already date by (`Time.tsx`, `Subtasks.tsx`), never the machine's
// UTC day: at 15:00 UTC on 30 September it is already 1 October here. A day
// is a calendar date with no time in it, so the arithmetic below is done at
// UTC midnight, where no daylight change can move it.

/** The clock the task screens date by. */
export const BUSINESS_CLOCK = 'Australia/Brisbane';

/** The business's day at `now`. */
export function todayOn(now: Date): string {
  // en-CA writes a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_CLOCK,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const atMidnight = (day: string): Date => new Date(`${day}T00:00:00Z`);

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

export function addDays(day: string, count: number): string {
  const date = atMidnight(day);
  date.setUTCDate(date.getUTCDate() + count);
  return dayOf(date);
}

/** The same day of the month `count` months on, held to the month's last day. */
export function addMonths(day: string, count: number): string {
  const date = atMidnight(day);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), last));
  return dayOf(target);
}

/** "November 2026". */
export function monthLabel(day: string): string {
  return atMidnight(day).toLocaleDateString('en-AU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The weeks of `day`'s month, Monday first; a cell outside the month is null. */
export function monthWeeks(day: string): readonly (readonly (string | null)[])[] {
  const date = atMidnight(day);
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const length = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  // getUTCDay counts from Sunday; the grid counts from Monday.
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let offset = 0; offset < length; offset += 1) cells.push(addDays(dayOf(first), offset));
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}
