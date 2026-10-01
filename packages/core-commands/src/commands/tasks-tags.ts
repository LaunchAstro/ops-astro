// SPDX-License-Identifier: AGPL-3.0-only
//
// Tags (MP-4-11, CS-4.20, CS-4.21): the three tag commands over the tag store
// (`core-records/src/tasks/tags.ts`).
//
// - `tag.create`: the envelope has asked `tag:write` of the business. A name
//   the business already has, in any case, is `UNIQUE_VALUE_TAKEN`.
// - `task.add_tag` and `task.remove_tag`: the envelope has asked `task:write`
//   of the task the body names. A tag that is not in this business's
//   vocabulary is `NOT_FOUND` on `tagId`, the answer a tag that does not exist
//   gets, so a refusal never says whether another business has it. Both answer
//   with the task, so the audit event's subject is the task: a tag on it, or
//   one taken off, is the task's content to the client lock (S0-5).
//
// Choosing a tag is always one of these commands: typed text is never a tag
// until it is created or chosen.

import {
  addTaskTag,
  createTag,
  removeTaskTag,
  TAG_NAME_LIMIT,
  tagNameOf,
} from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';

type TagContext = Pick<CommandContext, 'session'>;

const NO_TASK = refused(
  refuseCommand('NOT_FOUND', [], ['No live task carries that identifier here.']),
);
const NO_TAG = refused(
  refuseCommand('NOT_FOUND', ['tagId'], ['No tag of this business carries that identifier.']),
);

/** `tag.create`: a new name in the business's vocabulary. */
export async function createTagNamed(
  tx: TenantQuery,
  context: TagContext,
  value: unknown,
): Promise<HandlerOutcome> {
  const name = tagNameOf(value);
  if (name === undefined) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['name'],
        [`Send name as text of 1 to ${TAG_NAME_LIMIT} characters, with no control character.`],
      ),
    );
  }
  const made = await createTag(tx, { name, actorId: context.session.actorId });
  if (made.kind === 'taken') {
    return refused(
      refuseCommand(
        'UNIQUE_VALUE_TAKEN',
        ['name'],
        ['This business already has that tag. Choose it from the list instead.'],
      ),
    );
  }
  return applied(null, null, { tagId: made.tag.id, name: made.tag.name });
}

/** `task.add_tag`: one of the vocabulary's tags onto this task. */
export async function addTagToTask(
  tx: TenantQuery,
  context: TagContext,
  taskId: string,
  tagId: string,
): Promise<HandlerOutcome> {
  const added = await addTaskTag(tx, { taskId, tagId, actorId: context.session.actorId });
  if (added === 'no-task') return NO_TASK;
  if (added === 'no-tag') return NO_TAG;
  if (added === 'carried') {
    return refused(
      refuseCommand('UNIQUE_VALUE_TAKEN', ['tagId'], ['This task already carries that tag.']),
    );
  }
  return applied(taskId, null, { tagId });
}

/** `task.remove_tag`: the tag off this task; the vocabulary keeps it. */
export async function removeTagFromTask(
  tx: TenantQuery,
  _context: TagContext,
  taskId: string,
  tagId: string,
): Promise<HandlerOutcome> {
  const removed = await removeTaskTag(tx, { taskId, tagId });
  if (removed === 'no-task') return NO_TASK;
  if (removed === 'not-carried') return NO_TAG;
  return applied(taskId, null, { tagId });
}
