// SPDX-License-Identifier: AGPL-3.0-only
//
// The new-task draft (MP-4-13): what a person has put on it, and the Create
// that writes it.
//
// **Kept for its person until Create or Cancel (DN-04), within their own
// signed-in session.** The draft lives in this tab's storage under the
// business and the person, so X, Escape, navigating away and a reload keep it.
// Signing out, the session ending, a business switch and another person's
// sign-in drop it (ruling ORCH57, the panel host does it). Nothing reaches the
// server until Create.
//
// **The create's identity is kept with the draft** until the outcome is known,
// with the parts answered. A part's id is the create's and its place, a new
// tag's `tag.create` its part's and `.tag`, so every run of one attempt sends
// the same ids. A reload, an unmount or an unknown answer reopens the draft
// with them: the server replays, answered parts are skipped, and a part with no
// answer stops Create. An edit writes the draft without them; a drop drops all.
//
// **Create is the task first, then each part by its own command (DN-05;
// `draft-parts.ts`).**
// `task.create` writes the task; the client, the category, the owner, the
// note, the tags, the subtasks and the logged time then go through
// `task.set_party`, `task.set_category`, `task.assign`, `task.comment`, the
// tag commands, `task.create` under the new parent and `time.log`, so each is
// checked against its own permission and audited under its own name. A part
// refused once the task exists is named back to the person, never retried as
// a second task.

import type { Prefill } from './task-prefill.ts';

export interface TaskDraft {
  readonly title: string;
  /** A day, `YYYY-MM-DD`, or null. */
  readonly due: string | null;
  readonly estimate: number | null;
  /** Tag names as typed; matched to the vocabulary whatever the case at Create. */
  readonly tags: readonly string[];
  /** Subtask names, in order. */
  readonly steps: readonly string[];
  /** Time spent, as the log box takes it (`30m`, `1h 15m`), or empty. */
  readonly time: string;
  readonly note: string;
  /** The client from the page's scope, or null: never a fixed client. */
  readonly clientId: string | null;
  /** A category id (`TASK_CATEGORIES`), guessed from the page or chosen, or null. */
  readonly category: string | null;
  /** The owner the page named, or null: Create assigns nobody. */
  readonly owner: { readonly id: string; readonly name: string } | null;
  /** The sentence admitting what the page's guesses came from (DN-02), or null. */
  readonly why: string | null;
  /** The page it was filed from, kept with it so a reopened draft still names its own. */
  readonly from: string | null;
}

export const emptyDraft = (clientId: string | null): TaskDraft => ({
  title: '',
  due: null,
  estimate: null,
  tags: [],
  steps: [],
  time: '',
  note: '',
  clientId,
  category: null,
  owner: null,
  why: null,
  from: null,
});

/** A fresh draft with the page's guesses in it (DN-02). */
export const prefilledDraft = (prefill: Prefill): TaskDraft => ({
  ...emptyDraft(prefill.clientId),
  due: prefill.due,
  estimate: prefill.estimate,
  category: prefill.category,
  owner: prefill.owner,
  why: prefill.why,
});

const PREFIX = 'ops-astro.task-draft.';
const keyOf = (person: string): string => `${PREFIX}${person}`;

/** A Create not yet settled: its ids, the parts answered, the revision after, those refused. */
export interface Attempt {
  readonly id: string;
  readonly parts: readonly string[];
  readonly done: number;
  readonly revision: number | null;
  readonly missed: readonly string[];
}

export const newAttempt = (id: string): Attempt => ({
  id,
  parts: [],
  done: 0,
  revision: null,
  missed: [],
});

/** The draft as stored: its fields and the Create still unsettled. */
type Stored = Partial<TaskDraft> & { readonly attempt?: Partial<Attempt> };

function readStored(storage: Storage | null, person: string): Stored | null {
  try {
    const held = storage?.getItem(keyOf(person)) ?? null;
    return held === null ? null : (JSON.parse(held) as Stored);
  } catch {
    return null;
  }
}

/** The person's kept draft, or null when there is none or storage is blocked. */
export function readDraft(storage: Storage | null, person: string): TaskDraft | null {
  const stored = readStored(storage, person);
  if (stored === null) return null;
  const { attempt: _attempt, ...parsed } = stored;
  return { ...emptyDraft(null), ...parsed };
}

/** The draft's Create whose outcome is not known yet, or null. */
export function readAttempt(storage: Storage | null, person: string): Attempt | null {
  const attempt = readStored(storage, person)?.attempt;
  return typeof attempt?.id === 'string' ? { ...newAttempt(attempt.id), ...attempt } : null;
}

/** Keep the draft; with no `attempt`, an edit's write, any earlier attempt goes. */
export function keepDraft(
  storage: Storage | null,
  person: string,
  draft: TaskDraft,
  attempt: Attempt | null = null,
): void {
  try {
    const stored: Stored = attempt === null ? draft : { ...draft, attempt };
    storage?.setItem(keyOf(person), JSON.stringify(stored));
  } catch {
    // A blocked store keeps the draft only while the panel is open.
  }
}

/** Put `next` (null once settled) in place of attempt `id`, unless an edit has replaced it. */
export function saveAttempt(
  storage: Storage | null,
  person: string,
  id: string,
  next: Attempt | null,
): void {
  if (readAttempt(storage, person)?.id !== id) return;
  const draft = readDraft(storage, person);
  if (draft !== null) keepDraft(storage, person, draft, next);
}

export function dropDraft(storage: Storage | null, person: string): void {
  try {
    storage?.removeItem(keyOf(person));
  } catch {
    // Nothing was kept.
  }
}

/**
 * Remove every kept draft but `person`'s own (none when signed out): a draft
 * key of another person or business is removed unread.
 */
export function dropOtherDrafts(storage: Storage | null, person: string | null): void {
  try {
    if (storage === null) return;
    const own = person === null ? null : keyOf(person);
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (key !== null && key !== own && key.startsWith(PREFIX)) storage.removeItem(key);
    }
  } catch {
    // A blocked store kept nothing.
  }
}
