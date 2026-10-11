// SPDX-License-Identifier: AGPL-3.0-only
//
// The new-task draft (MP-4-13): what a person has put on it, and the Create
// that writes it.
//
// **Kept for its person until Create or Cancel (DN-04), within their own
// signed-in session.** The draft lives in this tab's storage under the
// business and the person, so X, Escape, navigating away and a reload keep it.
// When storage is unavailable, this tab's memory keeps it across panel remounts
// until the session ends; a reload cannot retain that fallback.
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
// `task.create` writes the task; the client, the project, the stage, the
// description, brief and priority, the category, the owner, the note, the
// tags, the subtasks and the logged time then go through `task.set_party`,
// `task.move`, `task.set_stage`, `task.update`, `task.set_category`,
// `task.assign`, `task.comment`, the tag commands, `task.create` under the new
// parent and `time.log`, so each is checked against its own permission and
// audited under its own name. The client and project go first: if either is
// refused, nothing after it is sent. A part refused once the task exists is
// named back to the person, never retried as a second task.

import { currentDraft, sessionGeneration } from './draft-storage.ts';
import { draftStored, type Attempt, type TaskDraft } from './draft-storage.ts';
export type { Attempt, TaskDraft } from './draft-storage.ts';
import type { Prefill } from './task-prefill.ts';

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
  timerFrom: null,
  timedMs: 0,
  boardId: null,
  stage: null,
  description: '',
  agentBrief: '',
  priority: null,
});

/** The draft with its running timer stopped at `now`, the time it ran added; as it was if none runs. */
export function stopTimer(draft: TaskDraft, now: number): TaskDraft {
  if (draft.timerFrom === null) return draft;
  const ran = now - Date.parse(draft.timerFrom);
  const timedMs = Number.isFinite(draft.timedMs) ? draft.timedMs : 0;
  return {
    ...draft,
    timerFrom: null,
    timedMs: timedMs + (Number.isFinite(ran) ? Math.max(0, ran) : 0),
  };
}

/** A day in minutes: the most one logged entry holds, as the task timer caps it. */
const DAY_MINUTES = 1440;

/**
 * The minutes Create logs for the draft's timer, as `time.stop` rounds the
 * task timer: rounded up, never fewer than one, at most a day; 0 if it never ran.
 */
export const timedMinutes = (draft: TaskDraft): number =>
  draft.timedMs > 0 ? Math.min(DAY_MINUTES, Math.max(1, Math.ceil(draft.timedMs / 60_000))) : 0;

/** A fresh draft with the page's guesses in it (DN-02). */
export const prefilledDraft = (prefill: Prefill): TaskDraft => ({
  ...emptyDraft(prefill.clientId),
  title: prefill.title,
  due: prefill.due,
  estimate: prefill.estimate,
  category: prefill.category,
  owner: prefill.owner,
  why: prefill.why,
  boardId: prefill.boardId,
  stage: prefill.stage,
  priority: prefill.priority,
});

const PREFIX = 'ops-astro.task-draft.';
const keyOf = (person: string): string => `${PREFIX}${person}`;

/** A Create not yet settled: its ids, the parts answered, the revision after, those refused. */

export const newAttempt = (id: string): Attempt => ({
  id,
  parts: [],
  done: 0,
  revision: null,
  missed: [],
});

/** The draft as stored: its fields and the Create still unsettled. */
type Stored = Partial<TaskDraft> & {
  readonly attempt?: Partial<Attempt>;
  readonly sessionGeneration?: number;
};

/** Writes browser storage could not keep, cleared by the same owner cleanup. */
const unstored = new Map<string, Stored>();

function readStored(storage: Storage | null, person: string): Stored | null {
  const fallback = unstored.get(person);
  if (fallback !== undefined) return currentDraft(fallback) ? fallback : null;
  try {
    const held = storage?.getItem(keyOf(person)) ?? null;
    if (held === null) return null;
    const parsed: unknown = JSON.parse(held);
    return draftStored(parsed) && currentDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The person's kept draft from browser storage or this tab's fallback, or null. */
export function readDraft(storage: Storage | null, person: string): TaskDraft | null {
  const stored = readStored(storage, person);
  if (stored === null) return null;
  const { attempt: _attempt, sessionGeneration: _generation, ...parsed } = stored;
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
  if (draftProblem(storage, person) !== null) return;
  const stored: Stored = {
    ...draft,
    sessionGeneration: sessionGeneration(),
    ...(attempt === null ? {} : { attempt }),
  };
  unstored.set(person, stored);
  try {
    if (storage === null) return;
    const serialised = JSON.stringify(stored);
    storage.setItem(keyOf(person), serialised);
    if (storage.getItem(keyOf(person)) === serialised) unstored.delete(person);
  } catch {
    // Keep the fallback across remounts when browser storage cannot write.
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
  if (draftProblem(storage, person) !== null) return;
  unstored.delete(person);
  try {
    storage?.removeItem(keyOf(person));
  } catch {
    // Browser storage is unavailable; the fallback has been cleared.
  }
}

/**
 * Remove every kept draft but `person`'s own (none when signed out): a draft
 * key of another person or business is removed unread.
 */
export function dropOtherDrafts(storage: Storage | null, person: string | null): void {
  for (const owner of unstored.keys()) {
    if (owner !== person) unstored.delete(owner);
  }
  try {
    if (storage === null) return;
    const own = person === null ? null : keyOf(person);
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (key !== null && key !== own && key.startsWith(PREFIX)) storage.removeItem(key);
    }
  } catch {
    // Browser storage is unavailable; other owners' fallbacks have been cleared.
  }
}

/** A known malformed copy stays untouched; ordinary unavailable storage keeps its existing fallback. */
export function draftProblem(storage: Storage | null, person: string): string | null {
  let raw: string | null;
  try {
    raw = storage?.getItem(keyOf(person)) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    if (draftStored(JSON.parse(raw) as unknown)) return null;
  } catch {
    /* Hold the raw copy. */
  }
  return 'The saved draft could not be read, so nothing was sent. It is kept as it was.';
}
