// SPDX-License-Identifier: AGPL-3.0-only
import { sessionGeneration } from '../../session/token.ts';
import { isOperationId } from '../../session/storage-slot.ts';

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
  /** When the draft's running timer started, ISO, or null (DN-05). */
  readonly timerFrom: string | null;
  /** Milliseconds the draft's timer has run; rounded once, at Create (`timedMinutes`). */
  readonly timedMs: number;
  /** The project (a board task's id) the task goes on, or null for none. */
  readonly boardId: string | null;
  /** A stage id (`TASK_STAGES`), or null. */
  readonly stage: string | null;
  readonly description: string;
  readonly agentBrief: string;
  /** P1 to P4, from the page or chosen, or null. */
  readonly priority: number | null;
}

export interface Attempt {
  readonly id: string;
  readonly parts: readonly string[];
  readonly done: number;
  readonly revision: number | null;
  readonly missed: readonly string[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((one: unknown) => typeof one === 'string');
const nullableText = (value: unknown): boolean => value === null || typeof value === 'string';
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function attempt(value: unknown): value is Attempt {
  return (
    object(value) &&
    Object.keys(value).length === 5 &&
    isOperationId(value['id']) &&
    strings(value['parts']) &&
    value['parts'].every(isOperationId) &&
    count(value['done']) &&
    value['done'] <= value['parts'].length &&
    (value['revision'] === null || (count(value['revision']) && value['revision'] > 0)) &&
    strings(value['missed'])
  );
}
const TEXT = new Set(['title', 'time', 'note', 'description', 'agentBrief']);
const NULLABLE_TEXT = new Set([
  'due',
  'clientId',
  'category',
  'why',
  'from',
  'timerFrom',
  'boardId',
  'stage',
]);
/** The unsent editor's representation, not a command envelope or proof of an old effect. */
export function draftStored(value: unknown): value is Partial<TaskDraft> & {
  readonly attempt?: Attempt;
  readonly sessionGeneration?: number;
} {
  if (!object(value)) return false;
  for (const [key, field] of Object.entries(value)) {
    if (TEXT.has(key)) {
      if (typeof field !== 'string') return false;
    } else if (NULLABLE_TEXT.has(key)) {
      if (!nullableText(field)) return false;
    } else if (key === 'tags' || key === 'steps') {
      if (!strings(field)) return false;
    } else if (key === 'estimate' || key === 'priority') {
      if (field !== null && (typeof field !== 'number' || !Number.isFinite(field))) return false;
    } else if (key === 'timedMs') {
      if (typeof field !== 'number' || !Number.isFinite(field) || field < 0) return false;
    } else if (key === 'owner') {
      if (
        field !== null &&
        (!object(field) ||
          Object.keys(field).length !== 2 ||
          typeof field['id'] !== 'string' ||
          typeof field['name'] !== 'string')
      )
        return false;
    } else if (key === 'sessionGeneration') {
      if (!count(field)) return false;
    } else if (key === 'attempt') {
      if (!attempt(field)) return false;
    } else return false;
  }
  return true;
}

/** Existing session endings fence newly kept drafts even when physical cleanup is refused. */
export { sessionGeneration } from '../../session/token.ts';
export function currentDraft(value: { readonly sessionGeneration?: number }): boolean {
  return value.sessionGeneration === undefined || value.sessionGeneration === sessionGeneration();
}
