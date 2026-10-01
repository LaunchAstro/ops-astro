// SPDX-License-Identifier: AGPL-3.0-only
//
// Root ruling 3 (ROOT-906613f-RULINGS.md, section 3) and ledger I03: every
// declared operation stays in the matrix. The (c) and (d) cells swap a task
// `recordId`, which reaches 17 of the 53. For each of the other 36 this file
// names where its target comparison is executed instead, or why it has none,
// once, so the matrix row and the case it points at cannot drift apart:
// `identifier-negatives.test.ts` titles its cases from `CASE` below.
//
// A harness, not a suite: nothing here runs on its own.

import type { CommandName } from '../../packages/core-wire/src/surface.ts';

type Body = Readonly<Record<string, unknown>>;

/** The executed identifier-negatives cases a matrix row can point at, by title. */
export const CASE = {
  control: 'refuses foreign and fabricated control identifiers alike',
  gate: 'refuses a foreign and a fabricated gate NOT_FOUND, as contract 8.2 case 1 names it',
  board: 'refuses a board read on a foreign or fabricated board, never an empty success',
  agent: 'refuses the agent alike on foreign, fabricated and in-business operands',
  pickup: 'refuses a pickup alike on a foreign, a fabricated and a claimed reservation',
  targetFree: 'refuses a target a target-free operation has no use for (SC2 reading)',
  conversation:
    'refuses a foreign and a fabricated conversation alike, NOT_FOUND byte for byte (AW-03)',
} as const;

/**
 * The twenty-five operations that name no identifier, each with a minimal valid body.
 *
 * A positive request moves and shows nothing of bravo's, and a `recordId` aimed
 * at bravo is refused `COMMAND_BODY_INVALID` (SC2, TRANSACTION-CONTRACT line
 * 113, root ruling 3). There is no foreign target to compare with a fabricated
 * one, so their matrix row is "not applicable" with that reason.
 */
export const TARGET_FREE: readonly (readonly [CommandName, Body])[] = [
  ['task.create', { fields: { title: 'a task made while bravo is watched' } }],
  ['task.purge', {}],
  ['settings.set_four_eyes_threshold', { value: 1300 }],
  ['settings.set_client_sign_off', { value: false }],
  ['task.queue', {}],
  ['gate.pending', {}],
  ['person.list', {}],
  ['preset.plan', { recordTypeKey: 'task', presetKey: 'acceptance', fields: [] }],
  ['settings.read', {}],
  ['session.capabilities', {}],
  // Custody (C31): the list and a set of a business-wide key name no row.
  ['secret.list', {}],
  ['secret.set', { name: 'target-free.key', value: 'target-free-value' }],
  // The connector fleet (MP-14-7a) names no row.
  ['connection.fleet', {}],
  // Grants, tripwires and the night round (MP-14-8) name no row either.
  ['connection.signal', {}],
  // The per-client region (MP-14-10a) names no row.
  ['connection.graduation', {}],
  // What agent runs cost (U39) name no row; the cost log takes its period.
  ['finance.skill_costs', {}],
  ['finance.agent_costs', { from: '2026-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' }],
  // The Workflow triggers registry (C33) names no row.
  ['automation.registry', {}],
  // A new client record (C41-A) names no row.
  ['record.create', { type: 'client', fields: { name: 'a target-free client' } }],
  ['conversation.start', { body: 'a conversation started while bravo is watched' }],
  ['conversation.list', {}],
  ['inbox.read', {}],
  ['inbox.count', {}],
  ['inbox.unattended', {}],
  ['notifications.set_channel', { channel: 'in_app', mode: 'on' }],
];

/** The identifier-bearing operations outside (c) and (d): operand and executed case. */
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
  'activation.change': ['versionId and activationId', 'control'],
  'definition.release': ['definitionId', 'control'],
  'activation.adopt': ['activationId and versionId', 'control'],
  'activation.roll_back': ['activationId', 'control'],
  'activation.turn_off': ['activationId', 'control'],
  'approval.revoke': ['approvalId', 'control'],
  'onboarding.start': ['clientId', 'control'],
  'onboarding.step_result': ['recordId', 'control'],
  'delegation.revoke': ['delegationId', 'control'],
  'task.decide': ['gateId', 'gate'],
  'task.board': ['board', 'board'],
  'task.heartbeat': ['leaseId', 'agent'],
  'task.dispatch': ['leaseId', 'agent'],
  'task.observe': ['leaseId', 'agent'],
  'task.receipt': ['attemptId', 'control'],
  'task.check': ['leaseId', 'agent'],
  'task.handback': ['leaseId', 'agent'],
  'model.call': ['leaseId', 'agent'],
  'task.pickup': ['reservationId', 'pickup'],
  'budget.top_up': ['recordId', 'control'],
  'budget.record_outcome': ['attemptId', 'control'],
  'budget.write_off': ['attemptId', 'control'],
  'conversation.message': ['conversationId', 'conversation'],
  'conversation.read': ['conversationId', 'conversation'],
  'conversation.rename': ['conversationId', 'conversation'],
  'conversation.set_scope': ['conversationId', 'conversation'],
  'run.top_up': ['runId and recordId', 'control'],
  'run.end_at_budget_stop': ['runId and recordId', 'control'],
  'run.revise_state': ['runId and recordId', 'control'],
  'inbox.seen': ['itemId', 'control'],
};

/**
 * The named row for an operation the (c) and (d) cells do not reach, or
 * `undefined` for one this file does not know, which the matrix throws on.
 */
export function alternativeFor(name: CommandName): string | undefined {
  const bearing = IDENTIFIER_BEARING[name];
  if (bearing !== undefined) {
    const [operand, kase] = bearing;
    return (
      `executed alternative: identifier-negatives.test.ts "${CASE[kase]}" compares a foreign ` +
      `and a fabricated ${operand} by status and raw bytes, audited at home (ledger I03)`
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
