// SPDX-License-Identifier: AGPL-3.0-only
//
// What the envelope hands a command, and which command it hands it to.
//
// A table keyed by the command name, beside the `COMMAND_SURFACE` row of the same name. It is not
// on that row because the web client imports the surface and must not import the handlers, which
// import the database. The switch it replaces was chosen over a table because a table keyed by name
// "would have been a lookup that returns undefined at runtime"; a mapped type over the request
// union answers that the same way the switch did, since a write added to the union with no entry
// here is a type error.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import type { HandlerOutcome } from './outcome.ts';
import { createTask, updateTask } from './tasks-write.ts';
import { setState, setStateById, writeOwnedFields } from './tasks-state.ts';
import { assignTask } from './tasks-agent.ts';
import { setScores } from './tasks-scores.ts';
import { setAdHoc } from './tasks-adhoc.ts';
import { setCategory } from './tasks-category.ts';
import { duplicateTask } from './tasks-duplicate.ts';
import { revokeClientShare, shareWithClient } from './tasks-client-access.ts';
import { setPartyWhileEmpty } from './task-client-lock.ts';
import { moveTask, rankTask, reparentTask } from './tasks-place.ts';
import { purgeTasks, restoreTasks, trashTask } from './tasks-trash.ts';
import { commentOnTask } from './tasks-comment.ts';
import { changeFrom, deleteTaskComment, editTaskComment } from './tasks-comment-edit.ts';
import { setNotificationChannel } from './settings-write.ts';
import { setting } from './handlers-setting.ts';
import { clearCustodySecret, setCustodySecret } from './custody-secrets.ts';
import { startConnectorRepair } from './connector-repair.ts';
import { recordIncident } from './privacy-write.ts';
import { approveVersion, draftVersion, publishVersion } from './legal-write.ts';
import { issueCredential, revokeCredential } from './credential-write.ts';
import { setService } from './overseas-write.ts';
import { setClass } from './data-class-write.ts';
import { changeInstallationMode, recordGateItem } from './gate-write.ts';
import { createClientRecord, grantOnAccess } from './access-write.ts';
import { recordStepResult, startOnboarding } from './onboarding.ts';
import { createRecord } from './record-create.ts';
import { setClientPrivacy } from './client-privacy-write.ts';
import { endAccessOnSettings } from './access-end.ts';
import { resetFactorOnSettings } from './factor-reset.ts';
import { decideOnGate } from './tasks-decide.ts';
import { acceptPlanOnGate } from './plan-accept.ts';
import { handbackOwnLease } from './tasks-handback.ts';
import { heartbeatOwnLease } from './tasks-lease.ts';
import { dispatchOwnLease } from './tasks-dispatch.ts';
import { observeOwnLease } from './tasks-observe.ts';
import { checkOwnLease } from './tasks-check.ts';
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
import { setPlanningCap } from './budget-planning-cap.ts';
import { messageConversation, startConversation } from './conversations.ts';
import { renameConversation, setConversationScope, setModel } from './conversation-tabs.ts';
import { refuseChildWorkAsPerson } from './child-work-person.ts';
import { refuseModelCallAsPerson } from './model-call-person.ts';
import { endOnRun, topUpOnRun } from './run-answers.ts';
import { reviseStateOnRun } from './run-state.ts';
import { deleteEntry, logTimeEntry, setEntryNote, startTime, stopTime } from './tasks-time.ts';
import { addTagToTask, createTagNamed, removeTagFromTask } from './tasks-tags.ts';
import { endOwnSession } from './session-end.ts';
import { dismissOwnTip, saveOwnPreference } from './preference-save.ts';
import { decideLiveCorrection, requestLiveCorrection, setApprover } from './live-corrections.ts';
import { stampOwnSeen } from './inbox-seen.ts';
import { markOwnRead, sendDirect } from './chat.ts';
import { invitationAct } from './invitations.ts';
import { scopeMap, setTaskType } from './wayfinder.ts';
import { changeActivationAsPerson, releaseDefinitionVersion } from './automations.ts';
import { reviseMap } from './wayfinder-revision.ts';
import {
  adoptActivationVersion,
  revokeStandingApproval,
  rollBackActivation,
  turnOffActivationAsPerson,
} from './automation-approvals.ts';

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
  'task.duplicate': duplicateTask,
  'task.set_audience': writeOwned,
  'task.set_scores': (tx, context, request) => setScores(tx, context, request.fields),
  'task.set_adhoc': (tx, context, request) => setAdHoc(tx, context, request.fields),
  'task.set_category': (tx, context, request) => setCategory(tx, context, request.fields),
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

  // The revision travels with the rest of the envelope rather than as a field of the settings
  // payload, and goes to the settings write as sent, so a settings body naming one is answered
  // instead of silently dropped: a mistyped one by the write's own `FIELD_VALUE_INVALID` (its row
  // says `any`).
  'settings.set_four_eyes_threshold': setting,
  'settings.set_client_sign_off': setting,
  'settings.set_money_step_up': setting,
  'settings.set_conversation_window': setting,
  'settings.set_retention_window': setting,

  'secret.set': (tx, context, request) => setCustodySecret(tx, context, request),
  'secret.clear': (tx, context, request) => clearCustodySecret(tx, context, request),
  'connector.repair': (tx, context, request) => startConnectorRepair(tx, context, request),

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
  // AW-04: the plan accept, the only activation of a run's instruction file.
  'task.accept_plan': acceptPlanOnGate,

  'client.create': createClientRecord,
  'record.create': (tx, context, request) => createRecord(tx, context, request),
  'onboarding.start': (tx, context, request) => startOnboarding(tx, context, request),
  'onboarding.step_result': (tx, context, request) => recordStepResult(tx, context, request),
  'client.set_privacy': setClientPrivacy,
  'access.grant': grantOnAccess,
  'access.revoke': (tx, context, request) => revokeGrantOnAccess(tx, context, request.grantId),
  'access.end': endAccessOnSettings,
  'access.reset_factor': resetFactorOnSettings,
  'grant.revoke': (tx, context, request) => revokeGrantAsManager(tx, context, request.grantId),
  'delegation.revoke': (tx, context, request) =>
    revokeDelegationAsManager(tx, context, request.delegationId),
  'task.cancel': cancelOnTask,
  'task.restart': restartOnTask,
  'live_correction.request': requestLiveCorrection,
  'live_correction.decide': decideLiveCorrection,
  'settings.set_live_correction_approver': setApprover,

  // EX-01. A person picks up, renews and hands back as themselves, on a lease that carries no
  // delegation; the agent does the same on its own entry point in `agent-envelope.ts`, with the
  // delegation its pickup minted. Neither reaches the other's lease: the runtime compares the
  // lease's holder and delegation under its locks.
  'task.pickup': pickupAsPerson,
  'task.heartbeat': heartbeatOwnLease,
  'task.dispatch': dispatchOwnLease,
  'task.observe': observeOwnLease,
  'task.check': checkOwnLease,
  'session.end': endOwnSession,
  'task.handback': handbackOwnLease,

  // T2e. A person's money decision; no agent route reaches it.
  'budget.top_up': topUpOnTask,
  // T3d1. A person's word on an unknown effect; no agent route reaches it.
  'budget.record_outcome': recordOutcomeOnTask,
  // T3c. A person closes an unknown hold at an amount; no agent route reaches it.
  'budget.write_off': writeOffOnTask,

  'task.set_type': setTaskType,
  'map.revise': reviseMap,
  'map.scope': scopeMap,
  // AW-04 (U10). A person sets the planning cap; no agent route reaches it.
  'budget.set_planning_cap': setPlanningCap,
  // AW-03: the conversation's first message mints it; later ones are its owner's.
  'conversation.start': startConversation,
  'conversation.message': messageConversation,
  // MP-7-11, CS-7.30: the tab row's title, the page it is about and its model, the owner's alone.
  'conversation.rename': renameConversation,
  'conversation.set_scope': setConversationScope,
  'conversation.set_model': setModel,
  // AW-01: the run's worker's, through the broker, on the agent prefix only.
  'model.call': refuseModelCallAsPerson,
  // AW-05: a person's answers to a run waiting at its approved ceiling.
  'run.top_up': topUpOnRun,
  'run.end_at_budget_stop': endOnRun,
  // MP-6-2: a run's state revised, a person's under run:write; an agent's in `agent-operations.ts`.
  'run.revise_state': reviseStateOnRun,
  // AW-11: the parent's and the helper's, on the agent prefix only.
  'run.delegate_child': refuseChildWorkAsPerson,
  'run.child_handback': refuseChildWorkAsPerson,
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
  // C71-D: the sender and reader are the session's; a body names only the teammate or conversation.
  'chat.send_direct': (tx, context, chat) => sendDirect(tx, context, chat.teammateId, chat.body),
  'chat.mark_read': (tx, context, chat) => markOwnRead(tx, context, chat.conversationId, chat.upTo),
  // C39-T: a person's acts on a team invitation, under `access:share`.
  'invitation.create': invitationAct,
  'invitation.resend': invitationAct,
  'invitation.revoke': invitationAct,
  // Settings ▸ Workflow triggers (C33), in `automations.ts`.
  'activation.change': changeActivationAsPerson,
  'definition.release': releaseDefinitionVersion,
  // Standing approvals (C52-A), in `automation-approvals.ts`.
  'activation.adopt': adoptActivationVersion,
  'activation.roll_back': rollBackActivation,
  'activation.turn_off': turnOffActivationAsPerson,
  'approval.revoke': revokeStandingApproval,
};

function writeOwned(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<'task.assign' | 'task.triage' | 'task.set_stage' | 'task.set_audience'>,
): Promise<HandlerOutcome> {
  return writeOwnedFields(tx, context, request.command, request.fields);
}

export async function handleCommand<K extends WriteName>(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<K>,
): Promise<HandlerOutcome> {
  const handler: Handler<K> = HANDLERS[request.command];
  return await handler(tx, context, request);
}
