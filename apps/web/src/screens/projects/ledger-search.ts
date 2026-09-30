// SPDX-License-Identifier: AGPL-3.0-only
//
// The Work log's search, read the way a person types it (MP-8-4, CS-8.9).
//
// Each word is placed as a person (any word of the name of someone who acted
// in view), else an event kind (by its plain words), else it is a free word.
// Facets of one kind OR together and different kinds AND together. People and
// kinds are a reading of the days in view; the free words are the ledger's
// `query`, which the server hands to C1's search, so no second search runs
// here. The page says back what it understood, because a box that silently
// reinterprets words is a trap.

import type { LedgerDayView } from '../../../../../packages/core-wire/src/index.ts';

interface Kind {
  /** How the reading line names them. */
  readonly label: string;
  /**
   * The ledger events' task operations, by verb: `create` is an event of
   * `task.create`. Verbs, not command names, since the page calls none of them.
   */
  readonly verbs: readonly string[];
  readonly words: readonly string[];
}

const KINDS: readonly Kind[] = [
  { label: 'comments', verbs: ['comment'], words: ['comment', 'comments', 'said'] },
  {
    label: 'completions',
    verbs: ['complete'],
    words: ['done', 'complete', 'completed', 'finished'],
  },
  { label: 'starts', verbs: ['start'], words: ['start', 'started'] },
  { label: 'creations', verbs: ['create'], words: ['create', 'created', 'new'] },
  { label: 'updates', verbs: ['update'], words: ['update', 'updated', 'edited'] },
  { label: 'assignments', verbs: ['assign'], words: ['assign', 'assigned'] },
  {
    label: 'stage changes',
    verbs: ['set_stage', 'move'],
    words: ['stage', 'stages', 'moved'],
  },
  { label: 'decisions', verbs: ['decide'], words: ['decided', 'decision', 'approved'] },
  {
    label: 'proposals',
    verbs: ['propose', 'restart'],
    words: ['proposed', 'proposal', 'proposals'],
  },
  { label: 'reopenings', verbs: ['reopen'], words: ['reopen', 'reopened'] },
];

export interface LedgerSearch {
  readonly people: readonly string[];
  readonly kinds: readonly Kind[];
  /** The free words, for C1's search. */
  readonly words: readonly string[];
}

/** Letters and digits only, as C1 takes them: nothing else is a word. */
const wordsIn = (typed: string): readonly string[] =>
  (typed.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);

/** `typed`, placed word by word against the people who acted in `days`. */
export function readSearch(typed: string, days: readonly LedgerDayView[]): LedgerSearch {
  const names = [...new Set(days.flatMap((day) => day.events.map((event) => event.actorName)))];
  const people: string[] = [];
  const kinds: Kind[] = [];
  const words: string[] = [];
  for (const word of wordsIn(typed)) {
    const person = names.find((name) => wordsIn(name).includes(word));
    const kind = KINDS.find((each) => each.words.includes(word));
    if (person !== undefined) {
      if (!people.includes(person)) people.push(person);
    } else if (kind !== undefined) {
      if (!kinds.includes(kind)) kinds.push(kind);
    } else if (!words.includes(word)) words.push(word);
  }
  return { people, kinds, words };
}

/** The ledger's `query`: the free words, or null when there are none. */
export const queryOf = (search: LedgerSearch): string | null =>
  search.words.length === 0 ? null : search.words.join(' ');

/** The days in view with only the events the people and kinds let through. */
export function passing(
  days: readonly LedgerDayView[],
  search: LedgerSearch,
): readonly LedgerDayView[] {
  const passes = (event: LedgerDayView['events'][number]): boolean =>
    (search.people.length === 0 || search.people.includes(event.actorName)) &&
    (search.kinds.length === 0 ||
      search.kinds.some((k) => k.verbs.some((verb) => event.operation === `task.${verb}`)));
  return days
    .map((day) => ({ ...day, events: day.events.filter(passes) }))
    .filter((day) => day.events.length > 0);
}

/** What the search was read as, or null when nothing was typed. */
export function readingLine(search: LedgerSearch, passed: number): string | null {
  const bits = [
    search.people.join(' or '),
    search.kinds.map((kind) => kind.label).join(' or '),
    search.words.length === 0
      ? ''
      : `the words ${search.words.map((word) => `“${word}”`).join(' + ')}`,
  ].filter((bit) => bit !== '');
  return bits.length === 0
    ? null
    : `Reading this as ${bits.join(' · ')} — ${String(passed)} of them`;
}
