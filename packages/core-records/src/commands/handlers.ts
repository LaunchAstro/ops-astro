// SPDX-License-Identifier: AGPL-3.0-only
//
// What the envelope hands a command, and which command it hands it to.
//
// The dispatch is a switch on the command name rather than a table of
// functions, because the request union is discriminated on the same name: a
// command added to the union with no branch here is a type error, and a table
// keyed by name would have been a lookup that returns undefined at runtime
// instead.

import type { TenantQuery } from '../tenancy/database.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import type { HandlerOutcome } from './outcome.ts';
import { createTask, updateTask } from './tasks-write.ts';
import { setState, writeOwnedFields } from './tasks-state.ts';
import { moveTask, rankTask, reparentTask } from './tasks-place.ts';
import { purgeTasks, restoreTasks, trashTask } from './tasks-trash.ts';
import { commentOnTask } from './tasks-comment.ts';
import { setBusinessSetting } from './settings-write.ts';
import { refuseUnlanded } from './pending.ts';

export async function handleCommand(
  tx: TenantQuery,
  context: CommandContext,
  request: CommandRequest,
): Promise<HandlerOutcome> {
  switch (request.command) {
    case 'task.create':
      return await createTask(tx, context, request);
    case 'task.update':
      return await updateTask(tx, context, request);

    case 'task.complete':
      return await setState(tx, context, 'completed');
    case 'task.reopen':
      return await setState(tx, context, 'unstarted', request.reason);
    case 'task.start':
      return await setState(tx, context, 'started');

    case 'task.assign':
    case 'task.triage':
    case 'task.set_stage':
    case 'task.set_party':
    case 'task.set_audience':
      return await writeOwnedFields(tx, context, request.command, request.fields);

    case 'task.reparent':
      return await reparentTask(tx, context, request.parentId);
    case 'task.move':
      return await moveTask(tx, context, request.board, request.boardSection ?? null);
    case 'task.rank':
      return await rankTask(tx, context, request.afterId ?? null, request.beforeId ?? null);

    case 'task.trash':
      return await trashTask(tx, context);
    case 'task.restore':
      return await restoreTasks(tx, context, request.batchId);
    case 'task.purge':
      return await purgeTasks(tx, context, request.olderThanDays);

    case 'task.comment':
      return await commentOnTask(tx, context, request.body, request.audience, request.commentType);

    case 'settings.set_four_eyes_threshold':
    case 'settings.set_client_sign_off':
      return await setBusinessSetting(tx, context, request.command, request.value);

    case 'task.propose':
    case 'task.decide':
    case 'task.pickup':
    case 'task.handback':
      return refuseUnlanded(context.declaration);
  }
}
