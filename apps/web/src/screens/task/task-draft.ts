// SPDX-License-Identifier: AGPL-3.0-only
//
// The new-task draft (MP-4-13): what a person has put on it, and the Create
// that writes it.
//
// **Kept for its person until Create or Cancel (DN-04).** The draft lives in
// this browser's storage under the business and the person, so X, Escape,
// navigating away and a reload keep it, and another person signed in here, or
// the same person in another business, never sees it. Nothing reaches the
// server until Create.
//
// **Create is the task first, then each part by its own command (DN-05).**
// `task.create` writes the task; the client, the note, the tags, the subtasks
// and the logged time then go through `task.set_party`, `task.comment`, the
// tag commands, `task.create` under the new parent and `time.log`, so each is
// checked against its own permission and audited under its own name. A part
// refused once the task exists is named back to the person, never retried as
// a second task.

import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type CommandOutcome,
  type OperationsClient,
} from '../../operations/client.ts';
import { settle } from '../../records/use-command.ts';

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
});

const keyOf = (person: string): string => `ops-astro.task-draft.${person}`;

/** The person's kept draft, or null when there is none or storage is blocked. */
export function readDraft(storage: Storage | null, person: string): TaskDraft | null {
  try {
    const held = storage?.getItem(keyOf(person)) ?? null;
    if (held === null) return null;
    const parsed = JSON.parse(held) as Partial<TaskDraft>;
    return { ...emptyDraft(null), ...parsed };
  } catch {
    return null;
  }
}

export function keepDraft(storage: Storage | null, person: string, draft: TaskDraft): void {
  try {
    storage?.setItem(keyOf(person), JSON.stringify(draft));
  } catch {
    // A blocked store keeps the draft only while the panel is open.
  }
}

export function dropDraft(storage: Storage | null, person: string): void {
  try {
    storage?.removeItem(keyOf(person));
  } catch {
    // Nothing was kept.
  }
}

export type CreateOutcome =
  | { readonly kind: 'created'; readonly key: string; readonly missed: readonly string[] }
  | { readonly kind: 'refused' | 'unknown'; readonly because: string };

type Result = CallResult<CommandOutcome>;

interface Part {
  readonly what: string;
  readonly run: () => Promise<Result>;
}

/** Create the task, then each part the draft holds; `operationId` is kept across an unknown outcome. */
export async function createFromDraft(
  client: OperationsClient,
  draft: TaskDraft,
  operationId: string,
): Promise<CreateOutcome> {
  const fields: Record<string, unknown> = { title: draft.title.trim() };
  if (draft.due !== null) fields['due'] = draft.due;
  if (draft.estimate !== null) fields['estimated_minutes'] = draft.estimate;
  const created = settle(
    await client.mutate('task.create', { fields, board: null }, { operationId }),
  );
  if (created.kind === 'unknown') return { kind: 'unknown', because: created.because };
  if (created.kind !== 'ok') return { kind: 'refused', because: created.because };
  const { recordId } = created.value;
  const at = { revision: created.value.revision };
  const missed: string[] = [];
  for (const part of partsOf(client, draft, recordId, at)) {
    // eslint-disable-next-line no-await-in-loop -- in order: each part writes after the task, at its revision
    const result = settle(await part.run());
    if (result.kind === 'ok') at.revision = result.value.revision;
    else missed.push(part.what);
  }
  const key = created.value.detail?.['key'];
  return { kind: 'created', key: typeof key === 'string' ? key : recordId, missed };
}

/** A part only when the draft holds it. */
const when = (held: boolean, part: Part): readonly Part[] => (held ? [part] : []);

/** Each part the draft holds, in the order Create writes them; `at` is the task's latest revision. */
function partsOf(
  client: OperationsClient,
  draft: TaskDraft,
  recordId: string,
  at: { revision: number },
): readonly Part[] {
  const note = draft.note.trim();
  const time = draft.time.trim();
  // The vocabulary is read once, at the first tag.
  let held: Promise<Map<string, string>> | null = null;
  const tags = (): Promise<Map<string, string>> => (held ??= vocabulary(client));
  const revision = (): { expectedRevision: number } => ({ expectedRevision: at.revision });
  return [
    ...when(draft.clientId !== null, {
      what: 'the client',
      run: () =>
        client.mutate(
          'task.set_party',
          { recordId, fields: { client: draft.clientId } },
          revision(),
        ),
    }),
    ...when(note !== '', {
      what: 'the note',
      run: () =>
        client.mutate(
          'task.comment',
          { recordId, body: note, audience: 'internal', commentType: 'note' },
          revision(),
        ),
    }),
    ...draft.tags.map((name) => ({
      what: `the tag ${name}`,
      run: async () => addTag(client, recordId, name, await tags()),
    })),
    ...draft.steps.map((title) => ({
      what: `the subtask ${title}`,
      run: () => client.mutate('task.create', { fields: { title }, parentId: recordId }),
    })),
    ...when(time !== '', {
      what: 'the time',
      run: () => client.mutate('time.log', { taskId: recordId, duration: time }),
    }),
  ];
}

/** The business's tags by lower-cased name; empty when the read is refused (each tag then is new). */
async function vocabulary(client: OperationsClient): Promise<Map<string, string>> {
  const read = await client.read<{ readonly tags: readonly { id: string; name: string }[] }>(
    'tag.list',
    {},
  );
  const held = new Map<string, string>();
  if (isRefusal(read) || isUnavailable(read)) return held;
  for (const tag of read.value.tags) held.set(tag.name.toLowerCase(), tag.id);
  return held;
}

/** Add a tag by name: the vocabulary's own, or a new one created first. */
async function addTag(
  client: OperationsClient,
  recordId: string,
  name: string,
  held: ReadonlyMap<string, string>,
): Promise<Result> {
  let tagId = held.get(name.toLowerCase());
  if (tagId === undefined) {
    const made = await client.mutate('tag.create', { name });
    if (isRefusal(made) || isUnavailable(made)) return made;
    const id = made.value.detail?.['tagId'];
    if (typeof id !== 'string') return { unavailable: true, because: 'No tag came back.' };
    tagId = id;
  }
  return client.mutate('task.add_tag', { recordId, tagId });
}
