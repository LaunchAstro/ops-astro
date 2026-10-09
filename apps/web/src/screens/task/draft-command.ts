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
  switch (part.kind) {
    case 'party':
      return command(
        'task.set_party',
        part.operationId,
        { recordId, fields: { client: part.clientId } },
        revision,
      );
    case 'category':
      return command(
        'task.set_category',
        part.operationId,
        { recordId, fields: { category: part.category } },
        revision,
      );
    case 'assignment':
      return command(
        'task.assign',
        part.operationId,
        { recordId, fields: { assignee: part.assigneeId } },
        revision,
      );
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
