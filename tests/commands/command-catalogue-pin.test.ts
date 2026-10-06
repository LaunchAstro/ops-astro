// SPDX-License-Identifier: AGPL-3.0-only
//
// The per-command tables, pinned as they stood at 06ab232.
//
// Written before the command facts were folded into the `COMMAND_SURFACE`
// rows (architecture review d8746a2, candidate 1), and green before and after.
// The tables no longer exist as lists: each is read here off the rows, and the
// agent's two lists are also checked against `agent-envelope.ts`, which still
// keeps its own copy until the agent path reads the rows.
// Five tables are pinned by literal: the runtime-shaped identifier, the
// identifiers each untargeted command takes, the commands that need no
// expected revision, and the agent's two allow-lists. The handler map is
// pinned by what `handleCommand` calls for each write and with which operands,
// so a derivation that sent a command to a different handler, or dropped an
// operand on the way, fails here.
//
// The five untargeted commands that `refuseIrrelevantTarget` never checked
// were pinned as `unchecked` at 06ab232. Architecture observation 2 flipped
// them, red first (`stray-identifiers.test.ts`): each now names the
// identifiers its request type declares, and that change was the one
// deliberate edit to this pin. The second is MP-4-9's `task.set_scores`, a new
// write an agent reaches inside its delegation: one row added to each table
// that lists every write or every agent operation, nothing else moved. The
// third is MP-4-10's `task.set_adhoc`, the same shape as the second. The
// fourth is MP-4-10's Client access, `task.share_with_client` and
// `task.revoke_client_share`: two writes an agent never reaches, one row each
// in the tables that list every write. The fifth is MP-4-5's author-only
// `task.edit_comment` and `task.delete_comment`, two writes an agent reaches
// inside its delegation, one row each in the tables that list every write or
// every agent operation, and `task.comment` handing on its `parentId`.
// The sixth is MP-4-4's parent scope behind S0-5's client lock: `task.set_party`
// goes to `setPartyWhileEmpty`, which refuses once the task has content and
// otherwise hands an empty task to `setParty` (parent scope, carry-down).
// The seventh is MP-4-6's five `time.*` writes: untargeted, an agent never
// reaches them, one row each in the tables that list every write or every
// untargeted one.
// The eighth is MP-4-11's tags: `tag.create`, `task.add_tag` and
// `task.remove_tag`, untargeted writes an agent never reaches, and the
// `tag.list` read, one row each in the tables that list every write, every
// untargeted one or every operation with no expected revision.
// The ninth is the status select's `task.set_state`: a targeted write an
// agent never reaches, to `setStateById` with its state id, one row each in
// the tables that list every write.
// The tenth is the category's `task.set_category` (MP-4-8, CS-4.16), the
// same shape as the third: a write an agent reaches inside its delegation, to
// `setCategory`, one row each in the tables that list every write or every
// agent operation.
// The eleventh is MP-4-8's `task.duplicate`: an untargeted write naming the old
// task in `recordId`, an agent never reaches it, to `duplicateTask` with its
// request, one row each in the tables that list every write, every untargeted
// one or every operation with no expected revision.
// The twelfth is AW-01's `model.call`: a new untargeted lease write an agent
// reaches under its delegation, added to each table it belongs in and to the
// handler map. The thirteenth is AW-05's two answers at the budget stop:
// untargeted person writes naming the task and the run on it, which no agent
// reaches.
// The fourteenth is AW-11's hand-over and handback: untargeted writes on
// `run` an agent reaches under its delegation, and a person is refused both
// by name.
// The fifteenth is C33's `activation.change` and `definition.release`:
// untargeted person writes no agent reaches, one row each in the tables that
// list every write, every untargeted one or every operation with no expected
// revision, beside the `automation.registry` read.
// The sixteenth is C52-A's `activation.adopt`, `activation.roll_back`,
// `activation.turn_off` and `approval.revoke`: untargeted person writes no
// agent reaches, one row each in the same three tables and the handler map.
//
// This suite moves the database counter by zero, so it is a unit suite and
// must not be named in `tests/db/named-suites.json`.

import { describe, expect, it, vi } from 'vitest';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import type { CommandContext } from '../../packages/core-commands/src/commands/context.ts';
import type { CommandRequest } from '../../packages/core-commands/src/commands/requests.ts';
import {
  COMMAND_SURFACE,
  NEEDS_NO_EXPECTED_REVISION,
  type CommandName,
} from '../../packages/core-wire/src/surface.ts';
import {
  AGENT_SURFACE,
  BEFORE_PICKUP,
} from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { handleCommand } from '../../packages/core-commands/src/commands/handlers.ts';

const calls: { readonly handler: string; readonly operands: readonly unknown[] }[] = [];

/** A stand-in that records its name and every argument after `tx` and `context`. */
function recorder(handler: string) {
  return (_tx: unknown, _context: unknown, ...operands: unknown[]) => {
    calls.push({ handler, operands });
    return Promise.resolve({ kind: 'pinned' });
  };
}

vi.mock('../../packages/core-commands/src/commands/conversations.ts', async (original) => ({
  ...(await original<object>()),
  startConversation: recorder('startConversation'),
  messageConversation: recorder('messageConversation'),
}));
vi.mock('../../packages/core-commands/src/commands/conversation-tabs.ts', async (original) => ({
  ...(await original<object>()),
  renameConversation: recorder('renameConversation'),
  setConversationScope: recorder('setConversationScope'),
}));
vi.mock('../../packages/core-commands/src/commands/session-end.ts', async (original) => ({
  ...(await original<object>()),
  endOwnSession: recorder('endOwnSession'),
}));
vi.mock('../../packages/core-commands/src/commands/preference-save.ts', async (original) => ({
  ...(await original<object>()),
  saveOwnPreference: recorder('saveOwnPreference'),
  dismissOwnTip: recorder('dismissOwnTip'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-write.ts', async (original) => ({
  ...(await original<object>()),
  createTask: recorder('createTask'),
  updateTask: recorder('updateTask'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-state.ts', async (original) => ({
  ...(await original<object>()),
  setState: recorder('setState'),
  setStateById: recorder('setStateById'),
  writeOwnedFields: recorder('writeOwnedFields'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-scores.ts', async (original) => ({
  ...(await original<object>()),
  setScores: recorder('setScores'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-adhoc.ts', async (original) => ({
  ...(await original<object>()),
  setAdHoc: recorder('setAdHoc'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-category.ts', async (original) => ({
  ...(await original<object>()),
  setCategory: recorder('setCategory'),
}));
vi.mock('../../packages/core-commands/src/commands/task-client-lock.ts', async (original) => ({
  ...(await original<object>()),
  setPartyWhileEmpty: recorder('setPartyWhileEmpty'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-duplicate.ts', async (original) => ({
  ...(await original<object>()),
  duplicateTask: recorder('duplicateTask'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-client-access.ts', async (original) => ({
  ...(await original<object>()),
  shareWithClient: recorder('shareWithClient'),
  revokeClientShare: recorder('revokeClientShare'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-place.ts', async (original) => ({
  ...(await original<object>()),
  moveTask: recorder('moveTask'),
  rankTask: recorder('rankTask'),
  reparentTask: recorder('reparentTask'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-trash.ts', async (original) => ({
  ...(await original<object>()),
  purgeTasks: recorder('purgeTasks'),
  restoreTasks: recorder('restoreTasks'),
  trashTask: recorder('trashTask'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-comment.ts', async (original) => ({
  ...(await original<object>()),
  commentOnTask: recorder('commentOnTask'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-comment-edit.ts', async (original) => ({
  ...(await original<object>()),
  changeFrom: () => 'change',
  editTaskComment: recorder('editTaskComment'),
  deleteTaskComment: recorder('deleteTaskComment'),
}));
vi.mock('../../packages/core-commands/src/commands/settings-write.ts', async (original) => ({
  ...(await original<object>()),
  setBusinessSetting: recorder('setBusinessSetting'),
  setNotificationChannel: recorder('setNotificationChannel'),
}));
vi.mock('../../packages/core-commands/src/commands/privacy-write.ts', async (original) => ({
  ...(await original<object>()),
  recordIncident: recorder('recordIncident'),
}));
vi.mock('../../packages/core-commands/src/commands/overseas-write.ts', async (original) => ({
  ...(await original<object>()),
  setService: recorder('setService'),
}));
vi.mock('../../packages/core-commands/src/commands/data-class-write.ts', async (original) => ({
  ...(await original<object>()),
  setClass: recorder('setClass'),
}));
vi.mock('../../packages/core-commands/src/commands/credential-write.ts', async (original) => ({
  ...(await original<object>()),
  issueCredential: recorder('issueCredential'),
  revokeCredential: recorder('revokeCredential'),
}));
vi.mock('../../packages/core-commands/src/commands/gate-write.ts', async (original) => ({
  ...(await original<object>()),
  recordGateItem: recorder('recordGateItem'),
  changeInstallationMode: recorder('changeInstallationMode'),
}));
vi.mock('../../packages/core-commands/src/commands/legal-write.ts', async (original) => ({
  ...(await original<object>()),
  draftVersion: recorder('draftVersion'),
  approveVersion: recorder('approveVersion'),
  publishVersion: recorder('publishVersion'),
}));
vi.mock('../../packages/core-commands/src/commands/custody-secrets.ts', async (original) => ({
  ...(await original<object>()),
  setCustodySecret: recorder('setCustodySecret'),
  clearCustodySecret: recorder('clearCustodySecret'),
}));
vi.mock('../../packages/core-commands/src/commands/connector-repair.ts', async (original) => ({
  ...(await original<object>()),
  startConnectorRepair: recorder('startConnectorRepair'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-propose.ts', async (original) => ({
  ...(await original<object>()),
  proposeOnTask: recorder('proposeOnTask'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-decide.ts', async (original) => ({
  ...(await original<object>()),
  decideOnGate: recorder('decideOnGate'),
}));
vi.mock('../../packages/core-commands/src/commands/plan-accept.ts', async (original) => ({
  ...(await original<object>()),
  acceptPlanOnGate: recorder('acceptPlanOnGate'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-pickup.ts', async (original) => ({
  ...(await original<object>()),
  pickupAsPerson: recorder('pickupAsPerson'),
}));
vi.mock('../../packages/core-commands/src/commands/automations.ts', async (original) => ({
  ...(await original<object>()),
  changeActivationAsPerson: recorder('changeActivationAsPerson'),
  releaseDefinitionVersion: recorder('releaseDefinitionVersion'),
}));
vi.mock('../../packages/core-commands/src/commands/automation-approvals.ts', async (original) => ({
  ...(await original<object>()),
  adoptActivationVersion: recorder('adoptActivationVersion'),
  rollBackActivation: recorder('rollBackActivation'),
  turnOffActivationAsPerson: recorder('turnOffActivationAsPerson'),
  revokeStandingApproval: recorder('revokeStandingApproval'),
}));
vi.mock('../../packages/core-commands/src/commands/wayfinder.ts', async (original) => ({
  ...(await original<object>()),
  setTaskType: recorder('setTaskType'),
  scopeMap: recorder('scopeMap'),
}));
vi.mock('../../packages/core-commands/src/commands/wayfinder-revision.ts', async (original) => ({
  ...(await original<object>()),
  reviseMap: recorder('reviseMap'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-handback.ts', async (original) => ({
  ...(await original<object>()),
  handbackOwnLease: recorder('handbackOwnLease'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-lease.ts', async (original) => ({
  ...(await original<object>()),
  heartbeatOwnLease: recorder('heartbeatOwnLease'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-dispatch.ts', async (original) => ({
  ...(await original<object>()),
  dispatchOwnLease: recorder('dispatchOwnLease'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-observe.ts', async (original) => ({
  ...(await original<object>()),
  observeOwnLease: recorder('observeOwnLease'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-check.ts', async (original) => ({
  ...(await original<object>()),
  checkOwnLease: recorder('checkOwnLease'),
}));
vi.mock('../../packages/core-commands/src/commands/authority-controls.ts', async (original) => ({
  ...(await original<object>()),
  revokeDelegationAsManager: recorder('revokeDelegationAsManager'),
  revokeGrantAsManager: recorder('revokeGrantAsManager'),
  revokeGrantOnAccess: recorder('revokeGrantOnAccess'),
}));
vi.mock('../../packages/core-commands/src/commands/access-write.ts', async (original) => ({
  ...(await original<object>()),
  createClientRecord: recorder('createClientRecord'),
  grantOnAccess: recorder('grantOnAccess'),
}));
vi.mock('../../packages/core-commands/src/commands/record-create.ts', async (original) => ({
  ...(await original<object>()),
  createRecord: recorder('createRecord'),
}));
vi.mock('../../packages/core-commands/src/commands/onboarding.ts', async (original) => ({
  ...(await original<object>()),
  startOnboarding: recorder('startOnboarding'),
  recordStepResult: recorder('recordStepResult'),
}));
vi.mock('../../packages/core-commands/src/commands/client-privacy-write.ts', async (original) => ({
  ...(await original<object>()),
  setClientPrivacy: recorder('setClientPrivacy'),
}));
vi.mock('../../packages/core-commands/src/commands/access-end.ts', async (original) => ({
  ...(await original<object>()),
  endAccessOnSettings: recorder('endAccessOnSettings'),
}));
vi.mock('../../packages/core-commands/src/commands/factor-reset.ts', async (original) => ({
  ...(await original<object>()),
  resetFactorOnSettings: recorder('resetFactorOnSettings'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-time.ts', async (original) => ({
  ...(await original<object>()),
  startTime: recorder('startTime'),
  stopTime: recorder('stopTime'),
  logTimeEntry: recorder('logTimeEntry'),
  setEntryNote: recorder('setEntryNote'),
  deleteEntry: recorder('deleteEntry'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-tags.ts', async (original) => ({
  ...(await original<object>()),
  createTagNamed: recorder('createTagNamed'),
  addTagToTask: recorder('addTagToTask'),
  removeTagFromTask: recorder('removeTagFromTask'),
}));
vi.mock('../../packages/core-commands/src/commands/invitations.ts', async (original) => ({
  ...(await original<object>()),
  invitationAct: recorder('invitationAct'),
}));
vi.mock('../../packages/core-commands/src/commands/inbox-seen.ts', async (original) => ({
  ...(await original<object>()),
  stampOwnSeen: recorder('stampOwnSeen'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-controls.ts', async (original) => ({
  ...(await original<object>()),
  cancelOnTask: recorder('cancelOnTask'),
  restartOnTask: recorder('restartOnTask'),
}));
vi.mock('../../packages/core-commands/src/commands/budget-top-up.ts', async (original) => ({
  ...(await original<object>()),
  topUpOnTask: recorder('topUpOnTask'),
}));
vi.mock('../../packages/core-commands/src/commands/budget-record-outcome.ts', async (original) => ({
  ...(await original<object>()),
  recordOutcomeOnTask: recorder('recordOutcomeOnTask'),
}));
vi.mock('../../packages/core-commands/src/commands/budget-write-off.ts', async (original) => ({
  ...(await original<object>()),
  writeOffOnTask: recorder('writeOffOnTask'),
}));
vi.mock('../../packages/core-commands/src/commands/budget-planning-cap.ts', async (original) => ({
  ...(await original<object>()),
  setPlanningCap: recorder('setPlanningCap'),
}));
vi.mock('../../packages/core-commands/src/commands/model-call-person.ts', async (original) => ({
  ...(await original<object>()),
  refuseModelCallAsPerson: recorder('refuseModelCallAsPerson'),
}));
vi.mock('../../packages/core-commands/src/commands/child-work-person.ts', async (original) => ({
  ...(await original<object>()),
  refuseChildWorkAsPerson: recorder('refuseChildWorkAsPerson'),
}));
vi.mock('../../packages/core-commands/src/commands/run-answers.ts', async (original) => ({
  ...(await original<object>()),
  topUpOnRun: recorder('topUpOnRun'),
  endOnRun: recorder('endOnRun'),
}));
vi.mock('../../packages/core-commands/src/commands/run-state.ts', async (original) => ({
  ...(await original<object>()),
  reviseStateOnRun: recorder('reviseStateOnRun'),
}));

const PINNED_RUNTIME_SHAPED = {
  'task.check': 'leaseId',
  'task.handback': 'leaseId',
  'task.heartbeat': 'leaseId',
  'task.dispatch': 'leaseId',
  'task.observe': 'leaseId',
  'task.pickup': 'reservationId',
  'model.call': 'leaseId',
  'run.delegate_child': 'leaseId',
};

const PINNED_UNTARGETED_IDENTIFIERS = {
  'activation.change': ['activationId', 'versionId'],
  'definition.release': ['definitionId'],
  'activation.adopt': ['activationId', 'versionId'],
  'activation.roll_back': ['activationId'],
  'activation.turn_off': ['activationId'],
  'approval.revoke': ['approvalId'],
  'budget.record_outcome': ['recordId', 'attemptId'],
  'budget.set_planning_cap': [],
  'budget.top_up': ['recordId'],
  'budget.write_off': ['recordId', 'attemptId'],
  'access.end': ['holderId'],
  'access.reset_factor': ['holderId'],
  'access.grant': ['holderId', 'clientId'],
  'access.revoke': ['grantId'],
  'client.create': [],
  'record.create': [],
  'onboarding.start': ['clientId'],
  'onboarding.step_result': ['recordId'],
  'client.set_privacy': ['clientId'],
  'conversation.message': ['conversationId'],
  'conversation.rename': ['conversationId'],
  'conversation.set_scope': ['conversationId'],
  'conversation.start': [],
  'delegation.revoke': [],
  'credential.issue': [],
  'credential.revoke': ['credentialId'],
  'grant.revoke': [],
  'secret.clear': ['secretId'],
  'secret.set': ['clientId'],
  'connector.repair': ['connectionId'],
  'preference.save': [],
  'preference.dismiss_tip': [],
  'session.end': [],
  'legal.approve_version': ['versionId'],
  'legal.draft_version': [],
  'legal.publish_version': ['versionId'],
  'model.call': ['leaseId'],
  'operations.change_installation_mode': [],
  'operations.record_gate_item': [],
  'privacy.record_incident': [],
  'privacy.set_data_class': [],
  'privacy.set_overseas_service': [],
  'run.child_handback': [],
  'run.delegate_child': ['leaseId'],
  'run.end_at_budget_stop': ['recordId', 'runId'],
  'run.revise_state': ['recordId', 'runId'],
  'run.top_up': ['recordId', 'runId'],
  'inbox.seen': ['itemId'],
  'invitation.create': [],
  'invitation.resend': ['invitationId'],
  'invitation.revoke': ['invitationId'],
  'notifications.set_channel': [],
  'settings.set_client_sign_off': [],
  'settings.set_four_eyes_threshold': [],
  'settings.set_money_step_up': [],
  'settings.set_conversation_window': [],
  'settings.set_retention_window': [],
  'task.accept_plan': ['gateId', 'versionId', 'conversationId'],
  'task.cancel': ['recordId', 'lineageId'],
  'task.check': ['leaseId'],
  'task.create': ['parentId', 'board', 'boardSection', 'conversationId'],
  'task.decide': ['gateId', 'versionId'],
  'task.handback': ['leaseId'],
  'task.heartbeat': ['leaseId'],
  'task.dispatch': ['leaseId'],
  'task.duplicate': ['recordId'],
  'task.observe': ['leaseId', 'attemptId'],
  'task.pickup': ['reservationId'],
  'task.purge': [],
  'task.restart': ['recordId', 'lineageId'],
  'task.restore': ['batchId'],
  'tag.create': [],
  'task.add_tag': ['recordId', 'tagId'],
  'task.remove_tag': ['recordId', 'tagId'],
  'time.delete': ['entryId'],
  'time.log': ['taskId'],
  'time.set_note': ['entryId'],
  'time.start': ['taskId'],
  'time.stop': ['taskId'],
};

const PINNED_NEEDS_NO_EXPECTED_REVISION = [
  'access.end',
  'access.grant',
  'access.read',
  'access.reset_factor',
  'access.revoke',
  'activation.adopt',
  'activation.change',
  'activation.roll_back',
  'activation.turn_off',
  'approval.revoke',
  'automation.registry',
  'budget.record_outcome',
  'budget.set_planning_cap',
  'budget.top_up',
  'budget.write_off',
  'client.create',
  'client.list',
  'client.set_privacy',
  'connection.fleet',
  'connection.signal',
  'connector.repair',
  'conversation.allowance',
  'conversation.list',
  'conversation.message',
  'conversation.read',
  'conversation.rename',
  'conversation.set_scope',
  'conversation.start',
  'credential.issue',
  'credential.revoke',
  'definition.attribution',
  'definition.release',
  'delegation.revoke',
  'gate.pending',
  'grant.revoke',
  'harness.read',
  'inbox.count',
  'inbox.read',
  'inbox.seen',
  'inbox.unattended',
  'invitation.create',
  'invitation.resend',
  'invitation.revoke',
  'legal.approve_version',
  'legal.draft_version',
  'legal.publish_version',
  'map.frontier',
  'map.view',
  'model.call',
  'notifications.set_channel',
  'onboarding.start',
  'onboarding.step_result',
  'operations.change_installation_mode',
  'operations.read',
  'operations.record_gate_item',
  'person.list',
  'preference.dismiss_tip',
  'preference.read',
  'preference.save',
  'preset.plan',
  'privacy.draft_breach_notices',
  'privacy.record_incident',
  'privacy.set_data_class',
  'privacy.set_overseas_service',
  'record.create',
  'run.child_handback',
  'run.delegate_child',
  'run.end_at_budget_stop',
  'run.revise_state',
  'run.top_up',
  'secret.clear',
  'secret.list',
  'secret.set',
  'session.capabilities',
  'session.end',
  'session.person',
  'settings.read',
  'settings.set_client_sign_off',
  'settings.set_conversation_window',
  'settings.set_four_eyes_threshold',
  'settings.set_money_step_up',
  'settings.set_retention_window',
  'tag.create',
  'tag.list',
  'task.accept_plan',
  'task.add_tag',
  'task.board',
  'task.cancel',
  'task.check',
  'task.create',
  'task.decide',
  'task.dispatch',
  'task.duplicate',
  'task.execution',
  'task.handback',
  'task.heartbeat',
  'task.ledger',
  'task.observe',
  'task.pickup',
  'task.purge',
  'task.queue',
  'task.read',
  'task.receipt',
  'task.remove_tag',
  'task.restart',
  'task.restore',
  'task.search',
  'task.todos',
  'team.list',
  'time.delete',
  'time.log',
  'time.set_note',
  'time.start',
  'time.stop',
  'trace.read',
];

const PINNED_AGENT_SURFACE = [
  'model.call',
  'onboarding.step_result',
  'run.child_handback',
  'run.delegate_child',
  'run.revise_state',
  'session.capabilities',
  // The assignee of its own task under a delegation holding assign (MP-4-8).
  'task.assign',
  'task.check',
  'task.comment',
  'task.create',
  'task.decide',
  'task.delete_comment',
  'task.dispatch',
  'task.edit_comment',
  'task.handback',
  'task.heartbeat',
  'task.observe',
  'task.pickup',
  'task.propose',
  'task.queue',
  'task.read',
  'task.set_adhoc',
  'task.set_category',
  'task.set_scores',
  'task.update',
];

const PINNED_BEFORE_PICKUP = ['task.pickup', 'task.queue'];

/** One request per write, each operand a distinct value so a dropped or swapped one shows. */
const REQUESTS: readonly CommandRequest[] = [
  { command: 'task.create', operationId: 'op', fields: { title: 'f-create' } },
  { command: 'task.update', operationId: 'op', recordId: 'r', fields: { title: 'f-update' } },
  { command: 'task.complete', operationId: 'op', recordId: 'r' },
  { command: 'task.reopen', operationId: 'op', recordId: 'r', reason: 'why-reopen' },
  {
    command: 'task.comment',
    operationId: 'op',
    recordId: 'r',
    body: 'b-comment',
    audience: 'a-comment',
    commentType: 't-comment',
    parentId: 'p-comment',
    mentions: 'm-comment',
  },
  {
    command: 'task.edit_comment',
    operationId: 'op',
    recordId: 'r',
    commentId: 'c-edit',
    body: 'b-edit',
  },
  { command: 'task.delete_comment', operationId: 'op', recordId: 'r', commentId: 'c-delete' },
  {
    command: 'task.propose',
    operationId: 'op',
    recordId: 'r',
    purpose: 'p-propose',
    maximumMinor: 1,
    currency: 'AUD',
    payload: {},
    step: { kind: 'k', payload: {} },
  },
  {
    command: 'task.decide',
    operationId: 'op',
    gateId: 'g',
    versionId: 'v',
    decision: 'approve',
    note: 'n',
  },
  {
    command: 'task.accept_plan',
    operationId: 'op',
    gateId: 'g-accept',
    versionId: 'v-accept',
    note: 'n-accept',
    planText: 't-accept',
    plan: {},
    entryPath: 'e-accept',
    paths: [],
  },
  { command: 'task.pickup', operationId: 'op', reservationId: 'res' },
  { command: 'task.handback', operationId: 'op', leaseId: 'l', fence: 2, outcome: 'done' },
  { command: 'task.start', operationId: 'op', recordId: 'r' },
  { command: 'task.set_state', operationId: 'op', recordId: 'r', stateId: 'state' },
  {
    command: 'task.duplicate',
    operationId: 'op',
    recordId: 'r',
    client: null,
    title: 't-duplicate',
    stepNames: [],
  },
  { command: 'task.assign', operationId: 'op', recordId: 'r', fields: { assignee: 'f-assign' } },
  { command: 'task.triage', operationId: 'op', recordId: 'r', fields: { intake: 'f-triage' } },
  { command: 'task.set_stage', operationId: 'op', recordId: 'r', fields: { stage: 'f-stage' } },
  { command: 'task.set_party', operationId: 'op', recordId: 'r', fields: { party: 'f-party' } },
  {
    command: 'task.set_audience',
    operationId: 'op',
    recordId: 'r',
    fields: { audience: 'f-audience' },
  },
  { command: 'task.set_scores', operationId: 'op', recordId: 'r', fields: { impact: 7 } },
  { command: 'task.set_adhoc', operationId: 'op', recordId: 'r', fields: { ad_hoc: true } },
  { command: 'task.set_category', operationId: 'op', recordId: 'r', fields: { category: 'seo' } },
  { command: 'task.share_with_client', operationId: 'op', recordId: 'r' },
  { command: 'task.revoke_client_share', operationId: 'op', recordId: 'r' },
  { command: 'task.reparent', operationId: 'op', recordId: 'r', parentId: 'parent' },
  { command: 'task.move', operationId: 'op', recordId: 'r', board: 'b', boardSection: 's' },
  { command: 'task.rank', operationId: 'op', recordId: 'r', afterId: 'after' },
  { command: 'task.trash', operationId: 'op', recordId: 'r' },
  { command: 'task.restore', operationId: 'op', batchId: 'batch' },
  { command: 'task.purge', operationId: 'op', olderThanDays: 9 },
  {
    command: 'settings.set_four_eyes_threshold',
    operationId: 'op',
    value: 5000,
    expectedRevision: 3,
  },
  { command: 'settings.set_client_sign_off', operationId: 'op', value: true },
  { command: 'settings.set_money_step_up', operationId: 'op', value: false },
  { command: 'settings.set_conversation_window', operationId: 'op', value: 14 },
  { command: 'settings.set_retention_window', operationId: 'op', value: 90 },
  {
    command: 'privacy.record_incident',
    operationId: 'op',
    whatHappened: 'w',
    foundAt: 'f',
    foundBy: 'b',
    affected: 'a',
    informationKinds: ['other'],
  },
  { command: 'legal.draft_version', operationId: 'op', document: 'd', version: 'v', body: 'b' },
  { command: 'legal.approve_version', operationId: 'op', versionId: 'version', digest: 'x' },
  { command: 'legal.publish_version', operationId: 'op', versionId: 'version' },
  {
    command: 'privacy.set_overseas_service',
    operationId: 'op',
    service: 's',
    receives: 'r',
    where: 'w',
    trainsOnIt: 't',
    contract: 'c',
    toConfirm: false,
    inUse: true,
  },
  {
    command: 'privacy.set_data_class',
    operationId: 'op',
    dataClass: 'd',
    purpose: 'p',
    disclosures: 'd',
    retention: 'r',
    deletion: 'd',
    inUse: true,
  },
  {
    command: 'credential.issue',
    operationId: 'op',
    scope: [{ collection: 'task', action: 'read' }],
    expiresAt: 'e',
    purpose: 'p',
  },
  { command: 'credential.revoke', operationId: 'op', credentialId: 'credential' },
  { command: 'operations.record_gate_item', operationId: 'op', item: 'i', evidence: 'e' },
  { command: 'operations.change_installation_mode', operationId: 'op', mode: 'm' },
  { command: 'client.create', operationId: 'op', name: 'n' },
  { command: 'record.create', operationId: 'op', type: 'client', fields: { name: 'n' } },
  { command: 'onboarding.start', operationId: 'op', clientId: 'c', templateKey: 'standard' },
  { command: 'onboarding.step_result', operationId: 'op', recordId: 'r', outcome: 'done' },
  {
    command: 'client.set_privacy',
    operationId: 'op',
    clientId: 'client',
    modelEgress: false,
    providers: [],
    handlesHealth: false,
    noAgentEdits: false,
  },
  {
    command: 'access.grant',
    operationId: 'op',
    holderId: 'person',
    collection: 'task',
    action: 'read',
    clientId: null,
  },
  { command: 'access.revoke', operationId: 'op', grantId: 'grant' },
  { command: 'access.end', operationId: 'op', holderId: 'person' },
  { command: 'secret.set', operationId: 'op', name: 'n', value: 'v' },
  { command: 'secret.clear', operationId: 'op', secretId: 's' },
  { command: 'access.reset_factor', operationId: 'op', holderId: 'person' },
  { command: 'connector.repair', operationId: 'op', connectionId: 'c' },
  { command: 'grant.revoke', operationId: 'op', grantId: 'grant' },
  { command: 'delegation.revoke', operationId: 'op', delegationId: 'delegation' },
  { command: 'task.cancel', operationId: 'op', recordId: 'r', lineageId: 'lin', reason: 'stop' },
  { command: 'task.restart', operationId: 'op', recordId: 'r', lineageId: 'lin' },
  { command: 'task.heartbeat', operationId: 'op', leaseId: 'l', fence: 4 },
  { command: 'task.dispatch', operationId: 'op', leaseId: 'l', fence: 4 },
  { command: 'task.observe', operationId: 'op', leaseId: 'l', fence: 4, attemptId: 'at' },
  {
    command: 'budget.top_up',
    operationId: 'op',
    recordId: 'r',
    amountMinor: 7,
    fromMaximumMinor: 8,
  },
  {
    command: 'budget.record_outcome',
    operationId: 'op',
    recordId: 'r',
    attemptId: 'at',
    outcome: 'happened',
  },
  {
    command: 'budget.write_off',
    operationId: 'op',
    recordId: 'r',
    attemptId: 'at',
    amountMinor: 0,
    reason: 'why',
  },
  { command: 'task.set_type', operationId: 'op', recordId: 'r', taskType: 'research' },
  { command: 'map.revise', operationId: 'op', recordId: 'r', notes: 'n' },
  { command: 'map.scope', operationId: 'op', recordId: 'r', client: 'c' },
  { command: 'activation.change', operationId: 'op', versionId: 'v', mode: 'manual' },
  { command: 'definition.release', operationId: 'op', name: 'n', modes: ['manual'] },
  { command: 'activation.adopt', operationId: 'op', activationId: 'a', versionId: 'v' },
  { command: 'activation.roll_back', operationId: 'op', activationId: 'a' },
  { command: 'activation.turn_off', operationId: 'op', activationId: 'a' },
  { command: 'approval.revoke', operationId: 'op', approvalId: 'p' },
  {
    command: 'budget.set_planning_cap',
    operationId: 'op',
    limitMinor: 2_000,
    currency: 'AUD',
    fromLimitMinor: null,
  },
  {
    command: 'task.check',
    operationId: 'op',
    leaseId: 'l',
    fence: 4,
    name: 'spelling',
    outcome: 'passed',
  },
  { command: 'conversation.start', operationId: 'op', body: 'hello', subject: 's' },
  { command: 'conversation.message', operationId: 'op', conversationId: 'c', body: 'again' },
  { command: 'conversation.rename', operationId: 'op', conversationId: 'c', title: 'Renamed' },
  { command: 'conversation.set_scope', operationId: 'op', conversationId: 'c', page: null },
  { command: 'model.call', operationId: 'op' },
  {
    command: 'run.top_up',
    operationId: 'op',
    recordId: 'r',
    runId: 'run',
    askId: 'ask',
    amountMinor: 700,
    currency: 'AUD',
  },
  {
    command: 'run.end_at_budget_stop',
    operationId: 'op',
    recordId: 'r',
    runId: 'run',
    askId: 'ask',
  },
  {
    command: 'run.revise_state',
    operationId: 'op',
    recordId: 'r',
    runId: 'run',
    expectedVersion: 0,
    knowledge: [],
    unknowns: [],
  },
  { command: 'run.delegate_child', operationId: 'op' },
  { command: 'run.child_handback', operationId: 'op' },
  { command: 'time.start', operationId: 'op', taskId: 't-start' },
  { command: 'time.stop', operationId: 'op', taskId: 't-stop' },
  { command: 'time.log', operationId: 'op', taskId: 't-log', duration: '1h', note: 'n-log' },
  { command: 'time.set_note', operationId: 'op', entryId: 'e-note', note: 'n-note' },
  { command: 'time.delete', operationId: 'op', entryId: 'e-delete' },
  { command: 'tag.create', operationId: 'op', name: 'n-tag' },
  { command: 'task.add_tag', operationId: 'op', recordId: 'r-add', tagId: 'g-add' },
  { command: 'task.remove_tag', operationId: 'op', recordId: 'r-remove', tagId: 'g-remove' },
  { command: 'session.end', operationId: 'op' },
  { command: 'preference.save', operationId: 'op', preference: 'appearance', value: 'dark' },
  {
    command: 'preference.dismiss_tip',
    operationId: 'op',
    page: 'agency:inbox',
    tip: 'triage',
    version: 1,
  },
  { command: 'inbox.seen', operationId: 'op', itemId: 'item' },
  { command: 'notifications.set_channel', operationId: 'op', channel: 'in_app', mode: 'on' },
  { command: 'invitation.create', operationId: 'op', name: 'N', email: 'e', role: 'member' },
  { command: 'invitation.resend', operationId: 'op', invitationId: 'i' },
  { command: 'invitation.revoke', operationId: 'op', invitationId: 'i' },
];

/** Where each request went: `[handler, ...what it was handed after tx and context]`. */
const PINNED_HANDLERS: Readonly<Record<string, readonly unknown[]>> = {
  'task.create': ['createTask', 'request'],
  'task.update': ['updateTask', 'request'],
  'task.complete': ['setState', 'completed'],
  'task.reopen': ['setState', 'unstarted', 'why-reopen'],
  'task.comment': [
    'commentOnTask',
    'op',
    'b-comment',
    'a-comment',
    't-comment',
    'p-comment',
    'm-comment',
  ],
  'task.edit_comment': ['editTaskComment', 'c-edit', 'b-edit'],
  'task.delete_comment': ['deleteTaskComment', 'c-delete'],
  'task.propose': ['proposeOnTask', 'request'],
  'task.decide': ['decideOnGate', 'request'],
  'task.accept_plan': ['acceptPlanOnGate', 'request'],
  'task.pickup': ['pickupAsPerson', 'request'],
  'task.handback': ['handbackOwnLease', 'request'],
  'task.start': ['setState', 'started'],
  'task.set_state': ['setStateById', 'state'],
  'task.duplicate': ['duplicateTask', 'request'],
  'task.assign': ['writeOwnedFields', 'task.assign', { assignee: 'f-assign' }],
  'task.triage': ['writeOwnedFields', 'task.triage', { intake: 'f-triage' }],
  'task.set_stage': ['writeOwnedFields', 'task.set_stage', { stage: 'f-stage' }],
  'task.set_party': ['setPartyWhileEmpty', { party: 'f-party' }],
  'task.set_audience': ['writeOwnedFields', 'task.set_audience', { audience: 'f-audience' }],
  'task.set_scores': ['setScores', { impact: 7 }],
  'task.set_adhoc': ['setAdHoc', { ad_hoc: true }],
  'task.set_category': ['setCategory', { category: 'seo' }],
  'task.share_with_client': ['shareWithClient'],
  'task.revoke_client_share': ['revokeClientShare'],
  'task.reparent': ['reparentTask', 'parent'],
  'task.move': ['moveTask', 'b', 's'],
  'task.rank': ['rankTask', 'after', null],
  'task.trash': ['trashTask'],
  'task.restore': ['restoreTasks', 'batch'],
  'task.purge': ['purgeTasks', 9],
  'settings.set_four_eyes_threshold': [
    'setBusinessSetting',
    'settings.set_four_eyes_threshold',
    5000,
    3,
  ],
  'settings.set_client_sign_off': [
    'setBusinessSetting',
    'settings.set_client_sign_off',
    true,
    undefined,
  ],
  'settings.set_money_step_up': [
    'setBusinessSetting',
    'settings.set_money_step_up',
    false,
    undefined,
  ],
  'settings.set_conversation_window': [
    'setBusinessSetting',
    'settings.set_conversation_window',
    14,
    undefined,
  ],
  'settings.set_retention_window': [
    'setBusinessSetting',
    'settings.set_retention_window',
    90,
    undefined,
  ],
  'privacy.record_incident': ['recordIncident', 'request'],
  'legal.draft_version': ['draftVersion', 'request'],
  'legal.approve_version': ['approveVersion', 'request'],
  'legal.publish_version': ['publishVersion', 'request'],
  'privacy.set_overseas_service': ['setService', 'request'],
  'privacy.set_data_class': ['setClass', 'request'],
  'credential.issue': ['issueCredential', 'request'],
  'credential.revoke': ['revokeCredential', 'request'],
  'operations.record_gate_item': ['recordGateItem', 'request'],
  'operations.change_installation_mode': ['changeInstallationMode', 'request'],
  'client.create': ['createClientRecord', 'request'],
  'record.create': ['createRecord', 'request'],
  'onboarding.start': ['startOnboarding', 'request'],
  'onboarding.step_result': ['recordStepResult', 'request'],
  'client.set_privacy': ['setClientPrivacy', 'request'],
  'access.grant': ['grantOnAccess', 'request'],
  'access.revoke': ['revokeGrantOnAccess', 'grant'],
  'access.end': ['endAccessOnSettings', 'request'],
  'secret.set': ['setCustodySecret', 'request'],
  'secret.clear': ['clearCustodySecret', 'request'],
  'access.reset_factor': ['resetFactorOnSettings', 'request'],
  'connector.repair': ['startConnectorRepair', 'request'],
  'grant.revoke': ['revokeGrantAsManager', 'grant'],
  'delegation.revoke': ['revokeDelegationAsManager', 'delegation'],
  'task.cancel': ['cancelOnTask', 'request'],
  'task.restart': ['restartOnTask', 'request'],
  'task.heartbeat': ['heartbeatOwnLease', 'request'],
  'task.dispatch': ['dispatchOwnLease', 'request'],
  'task.observe': ['observeOwnLease', 'request'],
  'budget.top_up': ['topUpOnTask', 'request'],
  'budget.record_outcome': ['recordOutcomeOnTask', 'request'],
  'budget.write_off': ['writeOffOnTask', 'request'],
  'task.set_type': ['setTaskType', 'request'],
  'map.revise': ['reviseMap', 'request'],
  'map.scope': ['scopeMap', 'request'],
  'activation.change': ['changeActivationAsPerson', 'request'],
  'definition.release': ['releaseDefinitionVersion', 'request'],
  'activation.adopt': ['adoptActivationVersion', 'request'],
  'activation.roll_back': ['rollBackActivation', 'request'],
  'activation.turn_off': ['turnOffActivationAsPerson', 'request'],
  'approval.revoke': ['revokeStandingApproval', 'request'],
  'budget.set_planning_cap': ['setPlanningCap', 'request'],
  'task.check': ['checkOwnLease', 'request'],
  'conversation.start': ['startConversation', 'request'],
  'conversation.message': ['messageConversation', 'request'],
  'conversation.rename': ['renameConversation', 'request'],
  'conversation.set_scope': ['setConversationScope', 'request'],
  'model.call': ['refuseModelCallAsPerson', 'request'],
  'run.top_up': ['topUpOnRun', 'request'],
  'run.end_at_budget_stop': ['endOnRun', 'request'],
  'run.revise_state': ['reviseStateOnRun', 'request'],
  'run.child_handback': ['refuseChildWorkAsPerson', 'request'],
  'run.delegate_child': ['refuseChildWorkAsPerson', 'request'],
  'time.start': ['startTime', 't-start'],
  'time.stop': ['stopTime', 't-stop'],
  'time.log': ['logTimeEntry', 't-log', '1h', 'n-log'],
  'time.set_note': ['setEntryNote', 'e-note', 'n-note'],
  'time.delete': ['deleteEntry', 'e-delete'],
  'tag.create': ['createTagNamed', 'n-tag'],
  'task.add_tag': ['addTagToTask', 'r-add', 'g-add'],
  'task.remove_tag': ['removeTagFromTask', 'r-remove', 'g-remove'],
  'session.end': ['endOwnSession', 'request'],
  'preference.save': ['saveOwnPreference', 'appearance', 'dark'],
  'preference.dismiss_tip': ['dismissOwnTip', 'request'],
  'inbox.seen': ['stampOwnSeen', 'item'],
  'notifications.set_channel': ['setNotificationChannel', 'request'],
  'invitation.create': ['invitationAct', 'request'],
  'invitation.resend': ['invitationAct', 'request'],
  'invitation.revoke': ['invitationAct', 'request'],
};

const untargetedWrites = COMMAND_SURFACE.filter(
  (command) => command.kind === 'write' && !command.targetsExistingRecord,
).map((command) => command.name);

/** One fact off every row that states it, by command name. */
function view<T>(fact: (row: (typeof COMMAND_SURFACE)[number]) => T | undefined) {
  return Object.fromEntries(
    COMMAND_SURFACE.flatMap((row) => {
      const value = fact(row);
      return value === undefined ? [] : [[row.name, value]];
    }),
  );
}

const RUNTIME_SHAPED = view((row) => row.runtimeShaped);
const UNTARGETED_IDENTIFIERS = view((row) => row.untargetedIdentifiers);
const agentReach = (reach: readonly string[]) =>
  COMMAND_SURFACE.filter((row) => reach.includes(row.agent))
    .map((row) => row.name)
    .toSorted();

describe('the per-command tables at 06ab232', () => {
  it('shapes the same runtime identifier for the same eight commands', () => {
    expect({ ...RUNTIME_SHAPED }).toStrictEqual(PINNED_RUNTIME_SHAPED);
  });

  it('checks the declared identifiers on every untargeted write', () => {
    const table: Readonly<Record<string, unknown>> = UNTARGETED_IDENTIFIERS;
    expect(
      Object.keys(table).filter((name) => !untargetedWrites.includes(name as CommandName)),
    ).toStrictEqual([]);
    const seen = Object.fromEntries(
      untargetedWrites.map((name) => [name, table[name] ?? 'unchecked']),
    );
    expect(seen).toStrictEqual(PINNED_UNTARGETED_IDENTIFIERS);
  });

  it('exempts the same one hundred and fifteen from an expected revision', () => {
    expect([...NEEDS_NO_EXPECTED_REVISION].toSorted()).toStrictEqual(
      PINNED_NEEDS_NO_EXPECTED_REVISION,
    );
  });

  it('lets an agent reach the same twenty-five, two of them before a pickup', () => {
    expect(agentReach(['delegated', 'before-pickup'])).toStrictEqual(PINNED_AGENT_SURFACE);
    expect(agentReach(['before-pickup'])).toStrictEqual(PINNED_BEFORE_PICKUP);
    expect([...AGENT_SURFACE].toSorted()).toStrictEqual(PINNED_AGENT_SURFACE);
    expect([...BEFORE_PICKUP].toSorted()).toStrictEqual(PINNED_BEFORE_PICKUP);
  });
});

describe('the per-command requests and handlers at 06ab232', () => {
  it('pins a request for every write in the surface', () => {
    const writes = COMMAND_SURFACE.filter((command) => command.kind === 'write').map(
      (command) => command.name,
    );
    expect(REQUESTS.map((request) => request.command).toSorted()).toStrictEqual(writes.toSorted());
    expect(Object.keys(PINNED_HANDLERS).toSorted()).toStrictEqual(writes.toSorted());
  });
});

describe('the per-command tables at 06ab232', () => {
  it.each(REQUESTS.map((request) => [request.command, request] as const))(
    'hands %s to the same handler with the same operands',
    async (name, request) => {
      calls.length = 0;
      const tx = {} as TenantQuery;
      const context = {} as CommandContext;
      await handleCommand(tx, context, request);
      expect(calls).toHaveLength(1);
      const [call] = calls;
      const operands = call?.operands.map((operand) => (operand === request ? 'request' : operand));
      expect([call?.handler, ...(operands ?? [])]).toStrictEqual(PINNED_HANDLERS[name]);
    },
  );
});
