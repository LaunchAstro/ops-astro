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
import { decideOnGate, proposeOnTask } from './tasks-runtime.ts';
import { revokeDelegationAsManager, revokeGrantAsManager } from './authority-controls.ts';
import { cancelOnTask, restartOnTask } from './tasks-controls.ts';
import { expectedRevisionOf } from './prepare.ts';
import { refuseCommand } from './refusal.ts';
import { refused } from './outcome.ts';

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

    // The two an agent does, and only an agent.
    //
    // `task.pickup` mints a delegation for an agent identity and `task.handback`
    // settles the one it minted, so both need an agent actor that a person's
    // session does not have and cannot be handed one: a body naming the agent
    // to mint for would be a body choosing whose authority is borrowed. They
    // are declared here and routed here because the surface is one surface —
    // an operation with no route breaks the enumeration — and they are served
    // on the agent's own entry point in `agent-envelope.ts`.
    case 'grant.revoke':
      return await revokeGrantAsManager(tx, context, request.grantId);
    case 'delegation.revoke':
      return await revokeDelegationAsManager(tx, context, request.delegationId);
    case 'task.cancel':
      return await cancelOnTask(tx, context, request);
    case 'task.restart':
      return await restartOnTask(tx, context, request);

    case 'task.pickup':
    case 'task.handback':
    case 'task.heartbeat':
      return refused(
        refuseCommand(
          'AUTH_NO_AGENT_IDENTITY',
          [request.command],
          [
            'An agent login picks work up and hands it back; a person authorises it by deciding.',
            'Present the agent credential on the agent entry point.',
          ],
        ),
      );
  }
}
