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
import {
  decideOnGate,
  handbackOwnLease,
  heartbeatOwnLease,
  pickupAsPerson,
  proposeOnTask,
} from './tasks-runtime.ts';
import { revokeDelegationAsManager, revokeGrantAsManager } from './authority-controls.ts';
import { cancelOnTask, restartOnTask } from './tasks-controls.ts';
import { expectedRevisionOf } from './prepare.ts';

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

    // The revision travels with the rest of the envelope rather than as a
    // field of the settings payload: `expectedRevisionOf` reads it the same
    // way the targeted commands' check does, so a settings body naming one is
    // answered instead of silently dropped.
    case 'settings.set_four_eyes_threshold':
    case 'settings.set_client_sign_off':
      return await setBusinessSetting(
        tx,
        context,
        request.command,
        request.value,
        expectedRevisionOf(request),
      );

    case 'task.propose':
      return await proposeOnTask(tx, context, request);
    case 'task.decide':
      return await decideOnGate(tx, context, request);

    case 'grant.revoke':
      return await revokeGrantAsManager(tx, context, request.grantId);
    case 'delegation.revoke':
      return await revokeDelegationAsManager(tx, context, request.delegationId);
    case 'task.cancel':
      return await cancelOnTask(tx, context, request);
    case 'task.restart':
      return await restartOnTask(tx, context, request);

    // EX-01. A person picks up, renews and hands back as themselves, on a
    // lease that carries no delegation; the agent does the same on its own
    // entry point in `agent-envelope.ts`, with the delegation its pickup
    // minted. Neither reaches the other's lease: the runtime compares the
    // lease's holder and delegation under its locks.
    case 'task.pickup':
      return await pickupAsPerson(tx, context, request);
    case 'task.heartbeat':
      return await heartbeatOwnLease(tx, context, request);
    case 'task.handback':
      return await handbackOwnLease(tx, context, request);
  }
}
