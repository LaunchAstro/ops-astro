// SPDX-License-Identifier: AGPL-3.0-only
//
// The parts of a new-task draft that Create writes after the task
// (MP-4-13, DN-05), each by its own command so each is checked against its
// own permission and audited under its own name: the client, the category,
// the owner, the note, the tags, the subtasks and the logged time.

import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type CommandOutcome,
  type OperationsClient,
} from '../../operations/client.ts';
import type { TaskDraft } from './task-draft.ts';

type Result = CallResult<CommandOutcome>;

interface Part {
  readonly what: string;
  readonly run: (operationId: string) => Promise<Result>;
}

/** A part only when the draft holds it. */
const when = (held: boolean, part: Part): readonly Part[] => (held ? [part] : []);

/** Each part the draft holds, in the order Create writes them; `at` is the task's latest revision. */
export function partsOf(
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
  const revision = (operationId: string): { expectedRevision: number; operationId: string } => ({
    expectedRevision: at.revision,
    operationId,
  });
  return [
    ...when(draft.clientId !== null, {
      what: 'the client',
      run: (operationId) =>
        client.mutate(
          'task.set_party',
          { recordId, fields: { client: draft.clientId } },
          revision(operationId),
        ),
    }),
    ...when(draft.category !== null, {
      what: 'the category',
      run: (operationId) =>
        client.mutate(
          'task.set_category',
          { recordId, fields: { category: draft.category } },
          revision(operationId),
        ),
    }),
    ...when(draft.owner !== null, {
      what: 'the owner',
      run: (operationId) =>
        client.mutate(
          'task.assign',
          { recordId, fields: { assignee: draft.owner?.id } },
          revision(operationId),
        ),
    }),
    ...when(note !== '', {
      what: 'the note',
      run: (operationId) =>
        client.mutate(
          'task.comment',
          { recordId, body: note, audience: 'internal', commentType: 'note' },
          revision(operationId),
        ),
    }),
    ...draft.tags.map((name) => ({
      what: `the tag ${name}`,
      run: async (id: string) => addTag(client, { recordId, name, operationId: id }, await tags()),
    })),
    ...draft.steps.map((title) => ({
      what: `the subtask ${title}`,
      run: (operationId: string) =>
        client.mutate('task.create', { fields: { title }, parentId: recordId }, { operationId }),
    })),
    ...when(time !== '', {
      what: 'the time',
      run: (operationId) =>
        client.mutate('time.log', { taskId: recordId, duration: time }, { operationId }),
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
  tag: { readonly recordId: string; readonly name: string; readonly operationId: string },
  held: ReadonlyMap<string, string>,
): Promise<Result> {
  const { recordId, name, operationId } = tag;
  let tagId = held.get(name.toLowerCase());
  if (tagId === undefined) {
    const made = await client.mutate('tag.create', { name }, { operationId: `${operationId}.tag` });
    if (isRefusal(made) || isUnavailable(made)) return made;
    const id = made.value.detail?.['tagId'];
    if (typeof id !== 'string') return { unavailable: true, because: 'No tag came back.' };
    tagId = id;
  }
  return client.mutate('task.add_tag', { recordId, tagId }, { operationId });
}
