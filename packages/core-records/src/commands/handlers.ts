// SPDX-License-Identifier: AGPL-3.0-only
//
// What the envelope hands a command, and which command it hands it to.
//
// A table keyed by the command name, beside the `COMMAND_SURFACE` row of the
// same name. It is not on that row because the web client imports the surface
// and must not import the handlers, which import the database. The switch it
// replaces was chosen over a table because a table keyed by name "would have
// been a lookup that returns undefined at runtime"; a mapped type over the
// request union answers that the same way the switch did, since a write added
// to the union with no entry here is a type error.

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

/**
 * Each write's request, by name. An intersection rather than `Extract`, so the
 * one union member that five owning operations share narrows to each of them.
 */
type WriteName = CommandRequest['command'];
type RequestOf<K extends WriteName> = CommandRequest & { readonly command: K };

type Handler<K extends WriteName> = (
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<K>,
) => Promise<HandlerOutcome>;

const HANDLERS: { readonly [K in WriteName]: Handler<K> } = {
  'task.create': createTask,
  'task.update': updateTask,

  'task.complete': (tx, context) => setState(tx, context, 'completed'),
  'task.reopen': (tx, context, request) => setState(tx, context, 'unstarted', request.reason),
  'task.start': (tx, context) => setState(tx, context, 'started'),

  'task.assign': writeOwned,
  'task.triage': writeOwned,
  'task.set_stage': writeOwned,
  'task.set_party': writeOwned,
  'task.set_audience': writeOwned,

  'task.reparent': (tx, context, request) => reparentTask(tx, context, request.parentId),
  'task.move': (tx, context, request) =>
    moveTask(tx, context, request.board, request.boardSection ?? null),
  'task.rank': (tx, context, request) =>
    rankTask(tx, context, request.afterId ?? null, request.beforeId ?? null),

  'task.trash': (tx, context) => trashTask(tx, context),
  'task.restore': (tx, context, request) => restoreTasks(tx, context, request.batchId),
  'task.purge': (tx, context, request) => purgeTasks(tx, context, request.olderThanDays),

  'task.comment': (tx, context, request) =>
    commentOnTask(tx, context, request.body, request.audience, request.commentType),

  // The revision travels with the rest of the envelope rather than as a
  // field of the settings payload: `expectedRevisionOf` reads it the same
  // way the targeted commands' check does, so a settings body naming one is
  // answered instead of silently dropped.
  'settings.set_four_eyes_threshold': setting,
  'settings.set_client_sign_off': setting,

  'task.propose': proposeOnTask,
  'task.decide': decideOnGate,

  'grant.revoke': (tx, context, request) => revokeGrantAsManager(tx, context, request.grantId),
  'delegation.revoke': (tx, context, request) =>
    revokeDelegationAsManager(tx, context, request.delegationId),
  'task.cancel': cancelOnTask,
  'task.restart': restartOnTask,

  // EX-01. A person picks up, renews and hands back as themselves, on a
  // lease that carries no delegation; the agent does the same on its own
  // entry point in `agent-envelope.ts`, with the delegation its pickup
  // minted. Neither reaches the other's lease: the runtime compares the
  // lease's holder and delegation under its locks.
  'task.pickup': pickupAsPerson,
  'task.heartbeat': heartbeatOwnLease,
  'task.handback': handbackOwnLease,
};

function writeOwned(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<
    'task.assign' | 'task.triage' | 'task.set_stage' | 'task.set_party' | 'task.set_audience'
  >,
): Promise<HandlerOutcome> {
  return writeOwnedFields(tx, context, request.command, request.fields);
}

function setting(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<'settings.set_four_eyes_threshold' | 'settings.set_client_sign_off'>,
): Promise<HandlerOutcome> {
  return setBusinessSetting(
    tx,
    context,
    request.command,
    request.value,
    expectedRevisionOf(request),
  );
}

export async function handleCommand<K extends WriteName>(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<K>,
): Promise<HandlerOutcome> {
  const handler: Handler<K> = HANDLERS[request.command];
  return await handler(tx, context, request);
}
