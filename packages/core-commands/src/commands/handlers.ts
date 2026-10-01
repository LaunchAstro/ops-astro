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

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import type { HandlerOutcome } from './outcome.ts';
import { createTask, updateTask } from './tasks-write.ts';
import { setState, setStateById, writeOwnedFields } from './tasks-state.ts';
import { assignTask } from './tasks-agent.ts';
import { setScores } from './tasks-scores.ts';
import { setAdHoc } from './tasks-adhoc.ts';
import { revokeClientShare, shareWithClient } from './tasks-client-access.ts';
import { setPartyWhileEmpty } from './task-client-lock.ts';
import { moveTask, rankTask, reparentTask } from './tasks-place.ts';
import { purgeTasks, restoreTasks, trashTask } from './tasks-trash.ts';
import { commentOnTask } from './tasks-comment.ts';
import { changeFrom, deleteTaskComment, editTaskComment } from './tasks-comment-edit.ts';
import { setBusinessSetting, setNotificationChannel } from './settings-write.ts';
import { recordIncident } from './privacy-write.ts';
import { approveVersion, draftVersion, publishVersion } from './legal-write.ts';
import { issueCredential, revokeCredential } from './credential-write.ts';
import { setService } from './overseas-write.ts';
import { setClass } from './data-class-write.ts';
import { changeInstallationMode, recordGateItem } from './gate-write.ts';
import { createClientRecord, grantOnAccess } from './access-write.ts';
import { endAccessOnSettings } from './access-end.ts';
import { decideOnGate } from './tasks-decide.ts';
import { handbackOwnLease } from './tasks-handback.ts';
import { heartbeatOwnLease } from './tasks-lease.ts';
import { dispatchOwnLease } from './tasks-dispatch.ts';
import { observeOwnLease } from './tasks-observe.ts';
import { pickupAsPerson } from './tasks-pickup.ts';
import { proposeOnTask } from './tasks-propose.ts';
import {
  revokeDelegationAsManager,
  revokeGrantAsManager,
  revokeGrantOnAccess,
} from './authority-controls.ts';
import { cancelOnTask, restartOnTask } from './tasks-controls.ts';
import { topUpOnTask } from './budget-top-up.ts';
import { recordOutcomeOnTask } from './budget-record-outcome.ts';
import { writeOffOnTask } from './budget-write-off.ts';
import { deleteEntry, logTimeEntry, setEntryNote, startTime, stopTime } from './tasks-time.ts';
import { addTagToTask, createTagNamed, removeTagFromTask } from './tasks-tags.ts';
import { endOwnSession } from './session-end.ts';
import { dismissOwnTip, saveOwnPreference } from './preference-save.ts';
import { stampOwnSeen } from './inbox-seen.ts';

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
  'task.set_state': (tx, context, request) => setStateById(tx, context, request.stateId),

  'task.assign': (tx, context, request) => assignTask(tx, context, request.fields),
  'task.triage': writeOwned,
  'task.set_stage': writeOwned,
  'task.set_party': (tx, context, request) => setPartyWhileEmpty(tx, context, request.fields),
  'task.set_audience': writeOwned,
  'task.set_scores': (tx, context, request) => setScores(tx, context, request.fields),
  'task.set_adhoc': (tx, context, request) => setAdHoc(tx, context, request.fields),
  'task.share_with_client': (tx, context) => shareWithClient(tx, context),
  'task.revoke_client_share': (tx, context) => revokeClientShare(tx, context),

  'task.reparent': (tx, context, request) => reparentTask(tx, context, request.parentId),
  'task.move': (tx, context, request) =>
    moveTask(tx, context, request.board, request.boardSection ?? null),
  'task.rank': (tx, context, request) =>
    rankTask(tx, context, request.afterId ?? null, request.beforeId ?? null),

  'task.trash': (tx, context) => trashTask(tx, context),
  'task.restore': (tx, context, request) => restoreTasks(tx, context, request.batchId),
  'task.purge': (tx, context, request) => purgeTasks(tx, context, request.olderThanDays),

  'task.comment': (tx, context, request) =>
    commentOnTask(
      tx,
      context,
      request.operationId,
      request.body,
      request.audience,
      request.commentType,
      request.parentId,
      request.mentions,
    ),
  'task.edit_comment': (tx, context, request) =>
    editTaskComment(tx, changeFrom(context), request.commentId, request.body),
  'task.delete_comment': (tx, context, request) =>
    deleteTaskComment(tx, changeFrom(context), request.commentId),

  // The revision travels with the rest of the envelope rather than as a
  // field of the settings payload, and goes to the settings write as sent,
  // so a settings body naming one is answered instead of silently dropped:
  // a mistyped one by the write's own `FIELD_VALUE_INVALID` (its row says
  // `any`).
  'settings.set_four_eyes_threshold': setting,
  'settings.set_client_sign_off': setting,
  'settings.set_money_step_up': setting,
  'settings.set_conversation_window': setting,
  'settings.set_retention_window': setting,

  'privacy.record_incident': recordIncident,
  'legal.draft_version': draftVersion,
  'legal.approve_version': approveVersion,
  'legal.publish_version': publishVersion,
  'credential.issue': issueCredential,
  'credential.revoke': revokeCredential,
  'privacy.set_overseas_service': setService,
  'privacy.set_data_class': setClass,
  'operations.record_gate_item': recordGateItem,
  'operations.change_installation_mode': changeInstallationMode,

  'task.propose': proposeOnTask,
  'task.decide': decideOnGate,

  'client.create': createClientRecord,
  'access.grant': grantOnAccess,
  'access.revoke': (tx, context, request) => revokeGrantOnAccess(tx, context, request.grantId),
  'access.end': endAccessOnSettings,
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
  'task.dispatch': dispatchOwnLease,
  'task.observe': observeOwnLease,
  'session.end': endOwnSession,
  'task.handback': handbackOwnLease,

  // T2e. A person's money decision; no agent route reaches it.
  'budget.top_up': topUpOnTask,
  // T3d1. A person's word on an unknown effect; no agent route reaches it.
  'budget.record_outcome': recordOutcomeOnTask,
  // T3c. A person closes an unknown hold at an amount; no agent route reaches it.
  'budget.write_off': writeOffOnTask,
  // MP-4-6. The person is the session's, so a body names only the task or
  // the entry, and what to write.
  'time.start': (tx, context, request) => startTime(tx, context, request.taskId),
  'time.stop': (tx, context, request) => stopTime(tx, context, request.taskId),
  'time.log': (tx, context, request) =>
    logTimeEntry(tx, context, request.taskId, request.duration, request.note),
  'time.set_note': (tx, context, request) =>
    setEntryNote(tx, context, request.entryId, request.note),
  'time.delete': (tx, context, request) => deleteEntry(tx, context, request.entryId),
  // MP-4-11. The envelope asked `tag:write` of the business for a new tag and
  // `task:write` of the task for adding and removing.
  'tag.create': (tx, context, request) => createTagNamed(tx, context, request.name),
  'task.add_tag': (tx, context, request) =>
    addTagToTask(tx, context, request.recordId, request.tagId),
  'task.remove_tag': (tx, context, request) =>
    removeTagFromTask(tx, context, request.recordId, request.tagId),

  'preference.save': (tx, context, request) =>
    saveOwnPreference(tx, context, request.preference, request.value),
  'preference.dismiss_tip': (tx, context, request) => dismissOwnTip(tx, context, request),
  'inbox.seen': (tx, context, request) => stampOwnSeen(tx, context, request.itemId),
  'notifications.set_channel': setNotificationChannel,
};

function writeOwned(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<'task.assign' | 'task.triage' | 'task.set_stage' | 'task.set_audience'>,
): Promise<HandlerOutcome> {
  return writeOwnedFields(tx, context, request.command, request.fields);
}

function setting(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<
    | 'settings.set_four_eyes_threshold'
    | 'settings.set_client_sign_off'
    | 'settings.set_money_step_up'
    | 'settings.set_conversation_window'
    | 'settings.set_retention_window'
  >,
): Promise<HandlerOutcome> {
  return setBusinessSetting(tx, context, request.command, request.value, request.expectedRevision);
}

export async function handleCommand<K extends WriteName>(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<K>,
): Promise<HandlerOutcome> {
  const handler: Handler<K> = HANDLERS[request.command];
  return await handler(tx, context, request);
}
