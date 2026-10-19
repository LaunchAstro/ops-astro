// SPDX-License-Identifier: AGPL-3.0-only
//
// Root ruling 3 (ROOT-906613f-RULINGS.md, section 3) and ledger I03: every
// declared operation stays in the matrix. The (c) and (d) cells swap a task
// `recordId`, which reaches 17 of the 75. For each of the other 58 this file
// names where its target comparison is executed instead, or why it has none,
// once, so the matrix row and the case it points at cannot drift apart:
// `identifier-negatives.test.ts` titles its cases from `CASE` below. A harness, not a suite.

import type { CommandName } from '../../packages/core-wire/src/surface.ts';

import { TARGET_FREE } from './cd-target-free.ts';

export { TARGET_FREE };

/** The executed identifier-negatives cases a matrix row can point at, by title. */
export const CASE = {
  control: 'refuses foreign and fabricated control identifiers alike',
  gate: 'refuses a foreign and a fabricated gate NOT_FOUND, as contract 8.2 case 1 names it',
  board: 'refuses a board read on a foreign or fabricated board, never an empty success',
  agent: 'refuses the agent alike on foreign, fabricated and in-business operands',
  pickup: 'refuses a pickup alike on a foreign, a fabricated and a claimed reservation',
  time: 'refuses a foreign and a fabricated task or time entry alike on the time commands',
  tag: 'refuses a foreign and a fabricated task alike on the tag commands',
  duplicate: 'refuses a duplicate of a foreign and a fabricated task alike',
  targetFree: 'refuses a target a target-free operation has no use for (SC2 reading)',
  liveCorrection: 'refuses a foreign and a fabricated correction or task alike (C80)',
  review: 'refuses a foreign and a fabricated task, revision or review alike (C35)',
  conversation:
    'refuses a foreign and a fabricated conversation alike, NOT_FOUND byte for byte (AW-03)',
} as const;

/** The sixty-five identifier-bearing operations outside (c) and (d): operand and executed case. */
export const IDENTIFIER_BEARING: Readonly<
  Partial<Record<CommandName, readonly [operand: string, kase: keyof typeof CASE]>>
> = {
  'task.cancel': ['lineageId and recordId', 'control'],
  'task.restart': ['lineageId and recordId', 'control'],
  'task.restore': ['batchId', 'control'],
  'grant.revoke': ['grantId', 'control'],
  'secret.clear': ['secretId', 'control'],
  'connector.repair': ['connectionId', 'control'],
  'mandate.file': ['clientId', 'control'],
  'mandate.revoke': ['mandateId', 'control'],
  'graduation.promote': ['classId', 'control'],
  'graduation.demote': ['classId', 'control'],
  'delegation.revoke': ['delegationId', 'control'],
  'task.decide': ['gateId', 'gate'],
  'task.accept_plan': ['gateId', 'gate'],
  'task.board': ['board', 'board'],
  'task.heartbeat': ['leaseId', 'agent'],
  'task.dispatch': ['leaseId', 'agent'],
  'task.observe': ['leaseId', 'agent'],
  'task.receipt': ['attemptId', 'control'],
  'task.check': ['leaseId', 'agent'],
  'task.handback': ['leaseId', 'agent'],
  'model.call': ['leaseId', 'agent'],
  'run.delegate_child': ['leaseId', 'agent'],
  // #1623 R1: the worker's own stop, by the lease its delegation holds.
  'run.end': ['leaseId', 'agent'],
  'task.pickup': ['reservationId', 'pickup'],
  'budget.top_up': ['recordId', 'control'],
  'budget.record_outcome': ['attemptId', 'control'],
  'budget.write_off': ['attemptId', 'control'],
  'live_correction.request': ['taskId', 'liveCorrection'],
  'live_correction.decide': ['correctionId', 'liveCorrection'],
  'live_correction.read': ['correctionId', 'liveCorrection'],
  'live_correction.receipts': ['correctionId', 'liveCorrection'],
  'live_correction.revert': ['correctionId', 'liveCorrection'],
  'live_correction.record_review': ['correctionId', 'liveCorrection'],
  'review.open': ['taskId', 'review'],
  'review.capture': ['revisionId', 'review'],
  'review.read': ['reviewId', 'review'],
  'conversation.message': ['conversationId', 'conversation'],
  'conversation.read': ['conversationId', 'conversation'],
  // AW-04: the drawer's allowance names the caller's own conversation, or none.
  'conversation.allowance': ['conversationId', 'conversation'],
  'conversation.rename': ['conversationId', 'conversation'],
  'conversation.set_scope': ['conversationId', 'conversation'],
  'conversation.models': ['conversationId', 'conversation'],
  'conversation.set_model': ['conversationId', 'conversation'],
  'run.top_up': ['runId and recordId', 'control'],
  'run.end_at_budget_stop': ['runId and recordId', 'control'],
  'run.revise_state': ['runId and recordId', 'control'],
  'time.start': ['taskId', 'time'],
  'time.stop': ['taskId', 'time'],
  'time.log': ['taskId', 'time'],
  'time.set_note': ['entryId', 'time'],
  'time.delete': ['entryId', 'time'],
  'task.add_tag': ['recordId', 'tag'],
  'task.remove_tag': ['recordId', 'tag'],
  'legal.approve_version': ['versionId', 'control'],
  'legal.publish_version': ['versionId', 'control'],
  'credential.revoke': ['credentialId', 'control'],
  'access.grant': ['holderId and clientId', 'control'],
  'access.revoke': ['grantId', 'control'],
  'access.end': ['holderId', 'control'],
  'access.reset_factor': ['holderId', 'control'],
  // C60: a client's privacy settings, by its client.
  'client.set_privacy': ['clientId', 'control'],
  'task.duplicate': ['recordId', 'duplicate'],
  'inbox.seen': ['itemId', 'control'],
  // C33: a version and an activation, and a definition to release on.
  'activation.change': ['versionId and activationId', 'control'],
  'definition.release': ['definitionId', 'control'],
  // New client onboarding (C41-A): the client a start names, the step task a result names.
  'onboarding.start': ['clientId', 'control'],
  'onboarding.step_result': ['recordId', 'control'],
  // C52-A: an activation and the version it adopts, and an approval to revoke.
  'activation.adopt': ['activationId and versionId', 'control'],
  'activation.roll_back': ['activationId', 'control'],
  'activation.turn_off': ['activationId', 'control'],
  'approval.revoke': ['approvalId', 'control'],
  // Assign to AI: bravo's agent, renamed from alpha.
  'agent.rename': ['agentId', 'control'],
};

/** Identifier-bearing operations compared in their own isolation suite, not identifier-negatives. */
const OWN_SUITE: Readonly<Partial<Record<CommandName, readonly [operand: string, suite: string]>>> =
  {
    'chat.send_direct': ['teammateId', 'c71-d'],
    'chat.messages': ['conversationId', 'c71-d'],
    'chat.mark_read': ['conversationId', 'c71-d'],
    'chat.start_group': ['members', 'c71-g'],
    'chat.send_group': ['conversationId', 'c71-g'],
    'chat.rename_group': ['conversationId', 'c71-g'],
    'chat.change_members': ['conversationId', 'c71-g'],
    'chat.leave': ['conversationId', 'c71-g'],
  };

/** An agent login's own operation: a person is refused by design, so the comparison runs on the agent entry. */
const AGENT_ENTRY: Readonly<Partial<Record<CommandName, string>>> = {
  'task.take_launch':
    'executed alternative: taking-a-launch-is-the-launched-agents-alone.test.ts compares ' +
    'another agent’s launchId and a fabricated one by the whole refusal, on the agent entry',
};

/** The named row for one the (c) and (d) cells miss; `undefined` if unknown (the matrix throws). */
export function alternativeFor(name: CommandName): string | undefined {
  const bearing = IDENTIFIER_BEARING[name];
  if (bearing !== undefined) {
    const [operand, kase] = bearing;
    return (
      `executed alternative: identifier-negatives.test.ts "${CASE[kase]}" compares a foreign ` +
      `and a fabricated ${operand} by status and raw bytes, audited at home (ledger I03)`
    );
  }
  const own = OWN_SUITE[name];
  if (own !== undefined) {
    return (
      `executed alternative: ${own[1]}-isolation.test.ts compares a foreign and a fabricated ` +
      `${own[0]} by status and raw bytes, audited at home`
    );
  }
  const agentEntry = AGENT_ENTRY[name];
  if (agentEntry !== undefined) return agentEntry;
  if (name === 'run.child_handback') {
    // AW-11: the body names nothing; the target is the helper's own child credential.
    return (
      'executed alternative: aw-11-child-commands-isolation.test.ts "another business" ' +
      "compares another business's child credential and a fabricated one by status and bytes"
    );
  }
  if (name === 'invitation.resend' || name === 'invitation.revoke') {
    // C39-T: the invitation is the target, not a task.
    return (
      'executed alternative: c39-t-invitation-refusals.test.ts "C39-T isolation" compares ' +
      "another business's invitation and a fabricated one by code and raw bytes"
    );
  }
  if (name === 'automation.history') {
    // #1741: the activation is the target, not a task.
    return (
      'executed alternative: an-activation-history-is-kept-to-settings-readers-of-its-own-business.test.ts ' +
      "compares another business's activation and a fabricated one by status and body"
    );
  }
  if (TARGET_FREE.some(([op]) => op === name)) {
    return (
      `not applicable: target-free (SC2, root ruling 3); identifier-negatives.test.ts ` +
      `"${CASE.targetFree}" proves no foreign effect and refuses an aimed recordId`
    );
  }
  return undefined;
}
