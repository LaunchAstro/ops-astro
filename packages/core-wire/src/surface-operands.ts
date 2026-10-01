// SPDX-License-Identifier: AGPL-3.0-only
//
// Each write's operands and their kinds, split out of `surface.ts` when the main merge joined it
// past the product file limit. `surface.ts` reads the table into each declaration.

import type { CommandName } from './command-names.ts';

/**
 * The JSON kind of one operand: `id` and `text` are strings, `count` a finite
 * number, `flag` a boolean, `map` an object that is not an array, `any`
 * whatever the command checks by value itself. `?` admits absent, `|null`
 * admits null.
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
    // The caller's own conversation the task is created from (AW-03's origin).
    conversationId: 'id?|null',
  },
  'task.update': FIELDS,
  'task.complete': TARGET,
  'task.reopen': { ...TARGET, reason: 'any' },
  'task.start': TARGET,
  'task.comment': {
    ...TARGET,
    body: 'any',
    audience: 'any',
    commentType: 'any',
    mentions: 'any',
  },
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
  'access.grant': { holderId: 'id', collection: 'any', action: 'any', clientId: 'id?|null' },
  'access.revoke': { grantId: 'id' },
  'access.end': { holderId: 'id' },
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
  },
  'task.check': {
    leaseId: 'any',
    recordId: 'any',
    fence: 'any',
    name: 'any',
    outcome: 'any',
    note: 'any',
  },
  'conversation.start': { body: 'any', title: 'any', subject: 'any', scope: 'any' },
  'conversation.message': { conversationId: 'any', body: 'any' },
  'conversation.rename': { conversationId: 'any', title: 'any' },
  'conversation.set_scope': { conversationId: 'any', page: 'any' },
  'model.call': { leaseId: 'any', fence: 'any', operation: 'any', fields: 'any' },
  'run.top_up': { recordId: 'any', runId: 'any', amountMinor: 'any', currency: 'any' },
  'run.end_at_budget_stop': { recordId: 'any', runId: 'any' },
  // The version the caller read (0 before the first); the two lists are
  // checked item by item by the handler.
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
  'session.end': {},
  'preference.save': { preference: 'text', value: 'any' },
  'preference.dismiss_tip': { page: 'text', tip: 'text', version: 'count' },
  'inbox.seen': { itemId: 'id' },
  'notifications.set_channel': { channel: 'text', mode: 'text', category: 'text?' },
  'invitation.create': { name: 'text', email: 'text', role: 'text' },
  'invitation.resend': { invitationId: 'id' },
  'invitation.revoke': { invitationId: 'id' },
};
