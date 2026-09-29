// SPDX-License-Identifier: AGPL-3.0-only
//
// The words the Projects board's cells draw (MP-5-8, BOARDS P-20, P-25, P-27,
// P-28, P-36). Pure; the column declarations are in `projects.ts`.

import type { Actual, Estimate, ProjectRow } from './projects.ts';

const NOT_RANKED = 'Not ranked yet — it is in the review queue';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MINUTES = 480;

export const pad = (n: number): string => String(n).padStart(2, '0');

/** `18 Jul` from a stored day (`YYYY-MM-DD…`, the day as picked). */
const dayWords = (iso: string): string => {
  const month = MONTHS[Number(iso.slice(5, 7)) - 1] ?? '';
  return `${String(Number(iso.slice(8, 10)))} ${month}`;
};

const hours = (minutes: number): string => `${String(Math.round((minutes / 60) * 10) / 10)}h`;

/** Minutes as the board says them: `45m`, `1.5h`, `4h`, `2d` (a day is 8 hours). */
export const timeWords = (minutes: number): string =>
  minutes < 60
    ? `${String(minutes)}m`
    : minutes >= DAY_MINUTES && minutes % DAY_MINUTES === 0
      ? `${String(minutes / DAY_MINUTES)}d`
      : hours(minutes);

/** Tokens as the board says them: `120k`. */
export const tokenWords = (tokens: number): string =>
  tokens < 1000 ? String(tokens) : `${String(Math.round(tokens / 1000))}k`;

/** The rank cell: the figure, or a dash titled as in the review queue (P-20). */
export function rankCell(row: ProjectRow): { readonly text: string; readonly title: string } {
  return row.rank.number === null
    ? { text: '—', title: NOT_RANKED }
    : { text: String(row.rank.number), title: row.rank.calc };
}

/**
 * The due cell (P-25): overdue with its day, `Today`, or the plain day,
 * judged against the reader's own calendar day; a completed task is never
 * overdue.
 */
export function dueWords(
  iso: string | null,
  completed: boolean,
  now: Date,
): { readonly text: string; readonly tone: 'overdue' | 'today' | 'plain' | 'none' } {
  if (iso === null) return { text: '—', tone: 'none' };
  const today = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const day = iso.slice(0, 10);
  if (!completed && day < today) return { text: `Overdue · ${dayWords(day)}`, tone: 'overdue' };
  if (!completed && day === today) return { text: 'Today', tone: 'today' };
  return { text: dayWords(day), tone: 'plain' };
}

/** The estimate cell (P-27): time in words, tokens as a figure computed, never typed. */
export function estimateWords(estimate: Estimate | null): {
  readonly text: string;
  readonly tokens: boolean;
  readonly title?: string;
} {
  if (estimate === null) return { text: '—', tokens: false };
  if (estimate.kind === 'time') return { text: timeWords(estimate.minutes), tokens: false };
  return {
    text: tokenWords(estimate.tokens),
    tokens: true,
    title: `estimated by ${estimate.by} · computed from the skills, never typed`,
  };
}

export interface Burn {
  /** Actual over estimate, capped at 1; null when there is nothing to compare. */
  readonly fill: number | null;
  readonly over: boolean;
  /** The figure printed beside or instead of the bar; null for the bar alone. */
  readonly figure: string | null;
  readonly title: string;
}

export const amount = (value: Estimate | Actual): number =>
  value.kind === 'time' ? value.minutes : value.tokens;

const words = (value: Estimate | Actual): string =>
  value.kind === 'time' ? timeWords(value.minutes) : tokenWords(value.tokens);

/** The burn bar (P-28): actual against estimate, of the same kind only. */
export function burnOf(estimate: Estimate | null, actual: Actual | null): Burn {
  if (actual === null) return { fill: null, over: false, figure: '—', title: '' };
  if (estimate === null || estimate.kind !== actual.kind || amount(estimate) <= 0) {
    return { fill: null, over: false, figure: words(actual), title: words(actual) };
  }
  const spent = amount(actual);
  const planned = amount(estimate);
  const over = spent > planned;
  const overrun = actual.kind === 'time' ? timeWords(spent - planned) : tokenWords(spent - planned);
  const runs = actual.kind === 'tokens' ? ` · ${String(actual.runs)} runs` : '';
  return {
    fill: Math.min(1, spent / planned),
    over,
    figure: over ? words(actual) : null,
    title: `${words(actual)} of ${words(estimate)}${over ? ` — ${overrun} over` : ''}${runs}`,
  };
}

export const burnRatio = (row: ProjectRow): number | null => {
  const burn = burnOf(row.estimate, row.actual);
  return burn.fill === null || row.estimate === null || row.actual === null
    ? null
    : amount(row.actual) / amount(row.estimate);
};

export const waiting = (row: ProjectRow): number => row.comments.client + row.comments.mentions;

/**
 * The comment badge (P-36): the exact count of the task's unanswered client
 * signals and open mentions, nothing at 0. Pressing it opens the task on its
 * comments; it never sorts (P-22) and never filters.
 */
export function commentBadge(
  row: ProjectRow,
): { readonly count: number; readonly title: string } | null {
  const count = waiting(row);
  if (count === 0) return null;
  const latest = row.comments.latest === null ? '' : ` · latest ${dayWords(row.comments.latest)}`;
  return {
    count,
    title: `${String(row.comments.client)} from the client · ${String(row.comments.mentions)} mentioning you${latest} — open the task on its comments`,
  };
}
