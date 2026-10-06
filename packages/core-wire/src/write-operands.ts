// SPDX-License-Identifier: AGPL-3.0-only
//
// Each write's operand table, moved whole from `surface.ts` to keep it under the 1,000-line limit;
// `surface.ts` reads it into each declaration and re-exports the operand types.

import type { CommandName } from './command-names.ts';
import { CONVERSATION_OPERANDS } from './write-operands-conversation.ts';
import { CHAT_OPERANDS } from './write-operands-chat.ts';
import { LIVE_CORRECTION_OPERANDS } from './surface-live-correction.ts';
import { SETUP_OPERANDS } from './surface-setup.ts';
import { WAYFINDER_OPERANDS } from './surface-wayfinder.ts';

/**
 * The JSON kind of one operand: `id` and `text` are strings, `count` a finite number, `flag` a
 * boolean, `map` an object that is not an array, `any` whatever the command checks by value
 * itself. `?` admits absent, `|null` admits null.
 */
export type OperandKind = 'id' | 'text' | 'count' | 'flag' | 'map' | 'any';
export type Operand = `${OperandKind}${'' | '?'}${'' | '|null'}`;
export type OperandSpec = Readonly<Record<string, Operand>>;

// Each write's operands, as `requests.ts` types them. `recordId` is here on
// every targeted command, and `operationId` and `expectedRevision` nowhere:
// the envelope reads those two itself. An operand whose kind its command
// already answers in its own words (a comment's `comment_type`, a pickup's
// reservation, a revocation's absent id, a reparent's parent after its task)
// is `any` here, so the caller keeps that answer and its place.
const TARGET = { recordId: 'id' } as const;
const FIELDS = { ...TARGET, fields: 'map' } as const;
export const WRITE_OPERANDS: Readonly<Partial<Record<CommandName, OperandSpec>>> = {
  'task.create': {
    fields: 'map',
    parentId: 'id?|null',
    board: 'id?|null',
    boardSection: 'id?|null',
    stateKey: 'any',
    taskType: 'any',
    // The caller's own conversation the task is created from (AW-03's origin).
    conversationId: 'id?|null',
  },
  'task.update': FIELDS,
  'task.complete': TARGET,
  'task.reopen': { ...TARGET, reason: 'any' },
  'task.start': TARGET,
  'task.set_state': { ...TARGET, stateId: 'id' },
  // The old task, the chosen client and the shell the person edited: no
  // operand for anything else, so nothing else can carry over (MP-4-8).
  'task.duplicate': {
    recordId: 'id',
    client: 'id|null',
    title: 'text',
    stepNames: 'any',
    confirmCarried: 'flag?',
  },
  'task.comment': {
    ...TARGET,
    body: 'any',
    audience: 'any',
    commentType: 'any',
    parentId: 'any',
    mentions: 'any',
  },
  'task.edit_comment': { ...TARGET, commentId: 'any', body: 'any' },
  'task.delete_comment': { ...TARGET, commentId: 'any' },
  'task.propose': {
    ...TARGET,
    purpose: 'any',
    maximumMinor: 'any',
    currency: 'any',
    payload: 'map',
    step: 'any',
    expiresInSeconds: 'any',
    lineageId: 'id?|null',
  },
  'task.decide': {
    gateId: 'id',
    versionId: 'id',
    decision: 'any',
    note: 'any',
    recipientPersonId: 'id?|null',
  },
  'task.accept_plan': {
    gateId: 'id',
    versionId: 'id',
    note: 'any',
    planText: 'any',
    plan: 'any',
    entryPath: 'any',
    paths: 'any',
    // The ceiling the card drew; refused under the locks if the version's differs.
    ceilingMinor: 'count?',
    currency: 'text?',
    conversationId: 'id?|null',
  },
  'task.pickup': { reservationId: 'any', leaseSeconds: 'any' },
  // A lease call names its task through its lease; a `recordId` beside the
  // lease is taken and plays no part in the check (API.md, id operands).
  'task.handback': {
    leaseId: 'any',
    recordId: 'any',
    fence: 'any',
    outcome: 'any',
    report: 'any',
    actualMinor: 'any',
    successor: 'any',
  },
  'task.assign': FIELDS,
  'task.triage': FIELDS,
  'task.set_stage': FIELDS,
  'task.set_party': FIELDS,
  'task.set_audience': FIELDS,
  'task.set_scores': FIELDS,
  'task.set_adhoc': FIELDS,
  'task.set_category': FIELDS,
  'task.share_with_client': TARGET,
  'task.revoke_client_share': TARGET,
  'task.reparent': { ...TARGET, parentId: 'any' },
  'task.move': { ...TARGET, board: 'any', boardSection: 'any' },
  'task.rank': { ...TARGET, afterId: 'id?|null', beforeId: 'id?|null' },
  'task.trash': TARGET,
  'task.restore': { batchId: 'id' },
  'task.purge': { olderThanDays: 'any' },
  'settings.set_four_eyes_threshold': { value: 'any', expectedRevision: 'any' },
  'settings.set_client_sign_off': { value: 'any', expectedRevision: 'any' },
  'settings.set_money_step_up': { value: 'any', expectedRevision: 'any' },
  'settings.set_conversation_window': { value: 'any', expectedRevision: 'any' },
  'settings.set_retention_window': { value: 'any', expectedRevision: 'any' },
  'privacy.record_incident': {
    whatHappened: 'any',
    foundAt: 'any',
    foundBy: 'any',
    affected: 'any',
    informationKinds: 'any',
  },
  'legal.draft_version': { document: 'any', version: 'any', body: 'any' },
  'legal.approve_version': { versionId: 'id', digest: 'any' },
  'legal.publish_version': { versionId: 'id' },
  'credential.issue': { scope: 'any', expiresAt: 'any', purpose: 'any' },
  'credential.revoke': { credentialId: 'id' },
  'privacy.set_overseas_service': {
    service: 'any',
    receives: 'any',
    where: 'any',
    trainsOnIt: 'any',
    contract: 'any',
    toConfirm: 'any',
    inUse: 'any',
  },
  'privacy.set_data_class': {
    dataClass: 'any',
    purpose: 'any',
    disclosures: 'any',
    retention: 'any',
    deletion: 'any',
    inUse: 'any',
  },
  'operations.record_gate_item': { item: 'any', evidence: 'any', statement: 'any?' },
  'operations.change_installation_mode': { mode: 'any' },
  'client.create': { name: 'any' },
  // Type and outcome are checked by value in the command; `recordId` is `any` so a missing one is refused by name.
  'record.create': { type: 'any', fields: 'map' },
  'onboarding.start': { clientId: 'id', templateKey: 'any' },
  'onboarding.step_result': { recordId: 'any', outcome: 'any', result: 'any' },
  'client.set_privacy': {
    clientId: 'id',
    modelEgress: 'any',
    providers: 'any',
    handlesHealth: 'any',
    noAgentEdits: 'any',
    requestedBy: 'any?',
    requestedOn: 'any?',
    requestLink: 'any?',
  },
  'access.grant': { holderId: 'id', collection: 'any', action: 'any', clientId: 'id?|null' },
  'access.revoke': { grantId: 'id' },
  'access.end': { holderId: 'id' },
  'access.reset_factor': { holderId: 'id' },
  'grant.revoke': { grantId: 'any' },
  'delegation.revoke': { delegationId: 'any' },
  'task.cancel': { recordId: 'any', lineageId: 'any', reason: 'any' },
  'task.restart': { recordId: 'any', lineageId: 'any', expiresInSeconds: 'any' },
  'task.heartbeat': {
    leaseId: 'any',
    recordId: 'any',
    fence: 'any',
    leaseSeconds: 'any',
    providerStarting: 'any',
  },
  'task.dispatch': { leaseId: 'any', recordId: 'any', fence: 'any' },
  // Minor units, of the maximum the person saw; no standing ceiling (Q168).
  'budget.top_up': { recordId: 'any', amountMinor: 'count', fromMaximumMinor: 'count' },
  // The task, the attempt held unknown, and one of the three outcomes (O7).
  'budget.record_outcome': { recordId: 'any', attemptId: 'any', outcome: 'any' },
  // The task, the attempt held unknown, the minor units charged and why (T3c).
  'budget.write_off': { recordId: 'any', attemptId: 'any', amountMinor: 'count', reason: 'text' },
  ...WAYFINDER_OPERANDS,
  // Minor units in the price book's currency, against the limit last seen (null: unset).
  'budget.set_planning_cap': {
    limitMinor: 'count',
    currency: 'text',
    fromLimitMinor: 'count|null',
  },
  'task.observe': {
    leaseId: 'any',
    recordId: 'any',
    fence: 'any',
    attemptId: 'any',
    usage: 'any',
    outcome: 'any',
    receiptLink: 'any',
  },
  'task.check': {
    leaseId: 'any',
    recordId: 'any',
    fence: 'any',
    name: 'any',
    outcome: 'any',
    note: 'any',
  },
  ...CONVERSATION_OPERANDS,
  'model.call': { leaseId: 'any', fence: 'any', operation: 'any', fields: 'any' },
  'run.top_up': {
    recordId: 'any',
    runId: 'any',
    askId: 'any',
    amountMinor: 'any',
    currency: 'any',
  },
  'run.end_at_budget_stop': { recordId: 'any', runId: 'any', askId: 'any' },
  // The version the caller read (0 before the first); the handler checks both lists item by item.
  'run.revise_state': {
    recordId: 'any',
    runId: 'any',
    expectedVersion: 'count',
    knowledge: 'any',
    unknowns: 'any',
  },
  // The parent's own lease and fence, then the helper and its narrower set.
  'run.delegate_child': {
    leaseId: 'any',
    recordId: 'any',
    fence: 'any',
    helperActorId: 'any',
    purpose: 'any',
    collections: 'any',
    actions: 'any',
    expiresInSeconds: 'any',
  },
  // The helper's credential says whose work it is; the body only how it went.
  'run.child_handback': { outcome: 'any', refusal: 'any' },
  // A duration is text the handler parses and answers in its own words.
  'time.start': { taskId: 'id' },
  'time.stop': { taskId: 'id' },
  'time.log': { taskId: 'id', duration: 'any', note: 'any' },
  'time.set_note': { entryId: 'id', note: 'any' },
  'time.delete': { entryId: 'id' },
  'tag.create': { name: 'any' },
  'task.add_tag': { recordId: 'id', tagId: 'id' },
  'task.remove_tag': { recordId: 'id', tagId: 'id' },
  'session.end': {},
  'preference.save': { preference: 'text', value: 'any' },
  'preference.dismiss_tip': { page: 'text', tip: 'text', version: 'count' },
  'inbox.seen': { itemId: 'id' },
  'notifications.set_channel': { channel: 'text', mode: 'text', category: 'text?' },
  ...CHAT_OPERANDS,
  'invitation.create': { name: 'text', email: 'text', role: 'text' },
  'invitation.resend': { invitationId: 'id' },
  'invitation.revoke': { invitationId: 'id' },
  // C33: every value but the identifiers is checked in the command, which names
  // the field it refuses; a version's modes against the activation's in the database.
  'activation.change': {
    activationId: 'id?',
    versionId: 'id',
    mode: 'any',
    everyMinutes: 'any',
    eventKind: 'any',
    enabled: 'any',
    expectedRevision: 'any',
  },
  'definition.release': {
    definitionId: 'id?',
    name: 'any',
    kind: 'any',
    contentDigest: 'any',
    contentSize: 'any',
    inputs: 'any',
    operations: 'any',
    modes: 'any',
  },
  // C52-A: the revision is checked in the command, which names it when refused.
  'activation.adopt': { activationId: 'id', versionId: 'id', expectedRevision: 'any' },
  'activation.roll_back': { activationId: 'id', expectedRevision: 'any' },
  'activation.turn_off': { activationId: 'id', expectedRevision: 'any' },
  'approval.revoke': { approvalId: 'id' },
  ...SETUP_OPERANDS,
  ...LIVE_CORRECTION_OPERANDS,
};
