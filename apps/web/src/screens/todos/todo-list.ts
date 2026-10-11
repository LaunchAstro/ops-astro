// SPDX-License-Identifier: AGPL-3.0-only
//
// The to-dos list's own logic (MP-7-1): the due urgency, the filter chips read
// from the search (XC 2-11), and the three sorts. Pure, so the words, the
// chips and the sort all read one derivation.
//
// **One today.** A task is due today when its day is the business's day or
// before it: the today scope and the Overdue and Today words both come from
// `urgencyOf`, read on the business clock (`due-dates.ts`), never the
// machine's UTC day.

import { TASK_CATEGORIES, type TodoView } from '../../../../../packages/core-wire/src/index.ts';
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

/**
 * One filter chip (PJ-02, PJ-03): what a typed word was read as. A word that
 * names an urgency, a waiting reply, whose move it is, a priority or a
 * category (three letters or more of its label) is read as that; `tag:` names
 * a tag; any other word without a colon is a name word.
 */
export type IdentityChip = {
  readonly kind: 'person' | 'client';
  readonly value: string;
  readonly name: string;
};
export type Chip =
  | IdentityChip
  | { readonly kind: 'route'; readonly value: TodoView['whoseMove'] }
  | {
      readonly kind: 'unresolved';
      readonly value: string;
      readonly reason: string;
      readonly choices: readonly IdentityChip[];
    }
  | { readonly kind: 'due'; readonly value: 'today' | 'overdue' | 'soon' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'move'; readonly value: TodoView['whoseMove'] }
  | { readonly kind: 'priority'; readonly value: number }
  | { readonly kind: 'category'; readonly value: string }
  | { readonly kind: 'tag' | 'words'; readonly value: string };

// Maps, not object indexes: a typed word is looked up in these own keys only,
// so `constructor` or `__proto__` is a name word, never an inherited property.
const DUE_WORDS: ReadonlyMap<string, 'today' | 'overdue' | 'soon'> = new Map([
  ['due:today', 'today'],
  ['today', 'today'],
  ['overdue', 'overdue'],
  ['late', 'overdue'],
  ['soon', 'soon'],
]);
const WAITING_WORDS = new Set(['waiting', 'comments', 'unread']);
const MOVE_WORDS: ReadonlyMap<string, TodoView['whoseMove']> = new Map([
  ['review', 'Review'],
  ['agent', 'Agent'],
  ['team', 'Team'],
]);

function chipOf(token: string): Chip | null {
  const due = DUE_WORDS.get(token);
  if (due !== undefined) return { kind: 'due', value: due };
  if (WAITING_WORDS.has(token)) return { kind: 'waiting' };
  const move = MOVE_WORDS.get(token);
  if (move !== undefined) return { kind: 'move', value: move };
  if (/^p[1-4]$/u.test(token)) return { kind: 'priority', value: Number(token.slice(1)) };
  if (token.startsWith('tag:')) return { kind: 'tag', value: token.slice(4) };
  if (token.includes(':')) return null;
  const category =
    token.length >= 3
      ? TASK_CATEGORIES.list().find((one) => one.label.toLowerCase().startsWith(token))
      : undefined;
  return category === undefined
    ? { kind: 'words', value: token }
    : { kind: 'category', value: category.id };
}

/** The chips typed words read as, lower-cased, in the order typed. */
export function scopeOf(query: string): readonly Chip[] {
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter((token) => token !== '')
    .map((token) => chipOf(token))
    .filter((chip) => chip !== null);
}

/** A chip's overline kind and value (PJ-03), and how the reading line says it (PJ-04). */
export function wordsOfChip(chip: Chip): {
  readonly kind: string;
  readonly value: string;
  readonly reading: string;
} {
  switch (chip.kind) {
    case 'person':
    case 'client':
      return { kind: chip.kind, value: chip.name, reading: `${chip.kind} “${chip.name}”` };
    case 'unresolved':
      return { kind: 'Scope', value: chip.value, reading: chip.reason };
    case 'route':
      return { kind: 'Route', value: chip.value, reading: `route ${chip.value}` };
    case 'due':
      return { kind: 'Due', value: chip.value, reading: `due ${chip.value}` };
    case 'waiting':
      return { kind: 'Only', value: 'waiting reply', reading: 'waiting on a reply' };
    case 'move':
      return { kind: 'Whose move', value: chip.value, reading: `whose move ${chip.value}` };
    case 'priority':
      return { kind: 'Priority', value: `P${chip.value}`, reading: `priority P${chip.value}` };
    case 'category': {
      const label = TASK_CATEGORIES.labelOf(chip.value);
      return { kind: 'Category', value: label, reading: `category “${label}”` };
    }
    case 'tag':
      return { kind: 'Tag', value: chip.value, reading: `tag “${chip.value}”` };
    default:
      return { kind: 'The words', value: chip.value, reading: `name “${chip.value}”` };
  }
}

/** The scope read back, in the order a person reads it; null when nothing scopes the list. */
export function readingOf(scope: readonly Chip[], focus: string | null): string | null {
  const parts = [
    ...(focus === null ? [] : [`waiting comments on ${focus}`]),
    ...scope.map((chip) => wordsOfChip(chip).reading),
  ];
  return parts.length === 0 ? null : `Reading this as: ${parts.join(', ')}`;
}

function keeps(chip: Chip, todo: TodoView, today: string): boolean {
  switch (chip.kind) {
    case 'due': {
      if (chip.value === 'today') return dueToday(todo.due, today);
      const urgency = urgencyOf(todo.due, today);
      if (chip.value === 'overdue') return urgency === 'overdue';
      return urgency === 'tomorrow' || urgency === 'week';
    }
    case 'person':
      return todo.assignee?.personId === chip.value;
    case 'client':
      // The server intersected this admitted client before serving any row.
      return true;
    case 'unresolved':
      return false;
    case 'route':
      return todo.whoseMove === chip.value;
    case 'waiting':
      return todo.waitingComments > 0;
    case 'move':
      return todo.whoseMove === chip.value;
    case 'priority':
      return todo.priority === chip.value;
    case 'category':
      return todo.category === chip.value;
    case 'tag':
      return todo.tags.some((tag) => tag.name.toLowerCase() === chip.value);
    default:
      return (todo.title ?? '').toLowerCase().includes(chip.value);
  }
}

/** The rows every chip keeps; `focus` is the one task whose comment count was pressed. */
export function scoped(
  todos: readonly TodoView[],
  scope: readonly Chip[],
  focus: string | null,
  today: string,
): readonly TodoView[] {
  return todos.filter(
    (todo) =>
      (focus === null || todo.key === focus) && scope.every((chip) => keeps(chip, todo, today)),
  );
}

export type SortKey = 'due' | 'task' | 'priority';

/** The list's sort (PJ-05, CS-7.24): a column and its direction, kept as `todos.sort`. */
export interface TodoSort {
  readonly key: SortKey;
  readonly direction: 'asc' | 'desc';
}

/** Due, earliest first: the sort with nothing stored. */
const FIRST_SORT: TodoSort = { key: 'due', direction: 'asc' };

/** The stored `todos.sort` as the list draws it; anything it cannot read is the default. */
export function sortOf(stored: unknown): TodoSort {
  if (typeof stored !== 'object' || stored === null) return FIRST_SORT;
  const { key, direction } = stored as Readonly<Record<string, unknown>>;
  const column = (['due', 'task', 'priority'] as const).find((one) => one === key);
  if (column === undefined || (direction !== 'asc' && direction !== 'desc')) return FIRST_SORT;
  return { key: column, direction };
}

/** A column head pressed: that column ascending, or reversed when it is already the sort. */
export const nextSort = (current: TodoSort, key: SortKey): TodoSort => ({
  key,
  direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
});

/** Nulls last, then the given order. */
const nullsLast = <T>(a: T | null, b: T | null, order: (x: T, y: T) => number): number => {
  if (a === null || b === null) return (a === null ? 1 : 0) - (b === null ? 1 : 0);
  return order(a, b);
};

const byDue = (a: TodoView, b: TodoView): number =>
  nullsLast(a.due, b.due, (x, y) => x.localeCompare(y));
const byName = (a: TodoView, b: TodoView): number =>
  (a.title ?? a.key).localeCompare(b.title ?? b.key, 'en-AU');

// Either way round, a task with no due or no priority stays last. Priority is
// a severity: ascending is P1 before P2.
const ORDERS: Readonly<Record<SortKey, (a: TodoView, b: TodoView, sign: number) => number>> = {
  due: (a, b, sign) => nullsLast(a.due, b.due, (x, y) => sign * x.localeCompare(y)) || byName(a, b),
  task: (a, b, sign) => sign * byName(a, b),
  priority: (a, b, sign) =>
    nullsLast(a.priority, b.priority, (x, y) => sign * (x - y)) || byDue(a, b),
};

export function sorted(todos: readonly TodoView[], sort: TodoSort): readonly TodoView[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return todos.toSorted((a, b) => ORDERS[sort.key](a, b, sign));
}
