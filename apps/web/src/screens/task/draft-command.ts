// SPDX-License-Identifier: AGPL-3.0-only
import type { DraftPart } from './draft-recipe.ts';
import type { DraftCommand, DraftCommandName, DraftReceipt } from './draft-receipts.ts';
export const command = (
  name: DraftCommandName,
  operationId: string,
  body: Readonly<Record<string, unknown>>,
  expectedRevision: number | null = null,
): DraftCommand =>
  Object.freeze({ command: name, operationId, body: freeze(body), expectedRevision });
function freeze<Value>(value: Value): Value {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function phaseCommand(
  part: DraftPart,
  parent: DraftReceipt,
  tagId: string | null = null,
): DraftCommand {
  const { recordId, revision } = parent;
  // An owning command writes its own fields on the task, at the revision the last part left.
  const owned = (name: DraftCommandName, id: string, fields: Readonly<Record<string, unknown>>) =>
    command(name, id, { recordId, fields }, revision);
  switch (part.kind) {
    case 'party':
      return owned('task.set_party', part.operationId, { client: part.clientId });
    case 'board':
      return command('task.move', part.operationId, { recordId, board: part.boardId }, revision);
    case 'stage':
      return owned('task.set_stage', part.operationId, { stage: part.stage });
    case 'details':
      return owned('task.update', part.operationId, part.fields);
    case 'category':
      return owned('task.set_category', part.operationId, { category: part.category });
    case 'assignment':
      return owned('task.assign', part.operationId, { assignee: part.assigneeId });
    case 'note':
      return command(
        'task.comment',
        part.operationId,
        { recordId, body: part.body, audience: 'internal', commentType: 'note' },
        revision,
      );
    case 'child':
      return command('task.create', part.operationId, {
        fields: { title: part.title },
        parentId: recordId,
      });
    case 'time':
      return command('time.log', part.operationId, { taskId: recordId, duration: part.duration });
    case 'tag':
      return tagId === null
        ? command('tag.create', part.createOperationId, { name: part.name })
        : command('task.add_tag', part.addOperationId, { recordId, tagId });
  }
}
