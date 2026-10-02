// SPDX-License-Identifier: AGPL-3.0-only
//
// The to-dos list's own logic (MP-7-1): the due urgency, the scope typed into
// the search, and the three sorts. Pure, so the words, the today scope and the
// sort all read one derivation.
//
// **One today.** A task is due today when its day is the business's day or
// before it: the today scope and the Overdue and Today words both come from
// `urgencyOf`, read on the business clock (`due-dates.ts`), never the
// machine's UTC day.

import type { TodoView } from '../../../../../packages/core-wire/src/index.ts';
import { addDays } from '../task/due-dates.ts';

export type Urgency = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'none';

export const URGENCY_WORDS: Readonly<Record<Urgency, string>> = {
  overdue: 'Overdue',
  today: 'Today',
  tomorrow: 'Tomorrow',
  week: 'This week',
  later: 'Later',
  none: 'No due date',
};

/** How soon a due day is, against the business's `today` (both `YYYY-MM-DD`). */
export function urgencyOf(due: string | null, today: string): Urgency {
  if (due === null) return 'none';
  const day = due.slice(0, 10);
  if (day < today) return 'overdue';
  if (day === today) return 'today';
  if (day === addDays(today, 1)) return 'tomorrow';
  return day <= addDays(today, 6) ? 'week' : 'later';
}

export const dueToday = (due: string | null, today: string): boolean =>
  ['overdue', 'today'].includes(urgencyOf(due, today));

/** What the search holds: name words, tag names and the today scope, each lower-cased. */
export interface Scope {
  readonly words: readonly string[];
  readonly tags: readonly string[];
  readonly today: boolean;
}

export function scopeOf(query: string): Scope {
  const tokens = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((token) => token !== '');
  return {
    words: tokens.filter((token) => !token.includes(':')),
    tags: tokens.filter((token) => token.startsWith('tag:')).map((token) => token.slice(4)),
    today: tokens.includes('due:today'),
  };
}

/** The scope read back, in the order a person reads it; null when nothing scopes the list. */
export function readingOf(scope: Scope, focus: string | null): string | null {
  const parts = [
    ...(focus === null ? [] : [`waiting comments on ${focus}`]),
    ...scope.tags.map((tag) => `tag “${tag}”`),
    ...(scope.today ? ['due today'] : []),
    ...scope.words.map((word) => `name “${word}”`),
  ];
  return parts.length === 0 ? null : `Reading this as: ${parts.join(', ')}`;
}

/** The rows the scope keeps; `focus` is the one task whose comment count was pressed. */
export function scoped(
  todos: readonly TodoView[],
  scope: Scope,
  focus: string | null,
  today: string,
): readonly TodoView[] {
  return todos.filter((todo) => {
    const name = (todo.title ?? '').toLowerCase();
    const tags = new Set(todo.tags.map((tag) => tag.name.toLowerCase()));
    return (
      (focus === null || todo.key === focus) &&
      scope.words.every((word) => name.includes(word)) &&
      scope.tags.every((tag) => tags.has(tag)) &&
      (!scope.today || dueToday(todo.due, today))
    );
  });
}

export type SortKey = 'due' | 'task' | 'priority';

/** Nulls last, then the given order. */
const nullsLast = <T>(a: T | null, b: T | null, order: (x: T, y: T) => number): number => {
  if (a === null || b === null) return (a === null ? 1 : 0) - (b === null ? 1 : 0);
  return order(a, b);
};

const byDue = (a: TodoView, b: TodoView): number =>
  nullsLast(a.due, b.due, (x, y) => x.localeCompare(y));
const byName = (a: TodoView, b: TodoView): number =>
  (a.title ?? a.key).localeCompare(b.title ?? b.key, 'en-AU');
// Priority is a severity: P1 before P2, and a task with none after them all.
const byPriority = (a: TodoView, b: TodoView): number =>
  nullsLast(a.priority, b.priority, (x, y) => x - y) || byDue(a, b);

const ORDERS: Readonly<Record<SortKey, (a: TodoView, b: TodoView) => number>> = {
  due: (a, b) => byDue(a, b) || byName(a, b),
  task: byName,
  priority: byPriority,
};

export const sorted = (todos: readonly TodoView[], by: SortKey): readonly TodoView[] =>
  todos.toSorted(ORDERS[by]);
