// SPDX-License-Identifier: AGPL-3.0-only
//
// Root ruling 3 (ROOT-906613f-RULINGS.md, section 3) and ledger I03: every
// declared operation stays in the matrix. The (c) and (d) cells swap a task
// `recordId`, which reaches 16 of the 35. For each of the other 19 this file
// names where its target comparison is executed instead, or why it has none,
// once, so the matrix row and the case it points at cannot drift apart:
// `identifier-negatives.test.ts` titles its cases from `CASE` below.
//
// A harness, not a suite: nothing here runs on its own.

import type { CommandName } from '../../packages/core-records/src/commands/surface.ts';

type Body = Readonly<Record<string, unknown>>;

/** The executed identifier-negatives cases a matrix row can point at, by title. */
export const CASE = {
  control: 'refuses foreign and fabricated control identifiers alike',
  gate: 'refuses a foreign and a fabricated gate NOT_FOUND, as contract 8.2 case 1 names it',
  board: 'refuses a board read on a foreign or fabricated board, never an empty success',
  agent: 'refuses the agent alike on foreign, fabricated and in-business operands',
  pickup: 'refuses a pickup alike on a foreign, a fabricated and a claimed reservation',
  targetFree: 'refuses a target a target-free operation has no use for (SC2 reading)',
} as const;

/**
 * The nine operations that name no identifier, each with a minimal valid body.
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
  ['person.list', {}],
  ['preset.plan', { recordTypeKey: 'task', presetKey: 'acceptance', fields: [] }],
  ['settings.read', {}],
  ['session.capabilities', {}],
];

/** The ten identifier-bearing operations outside (c) and (d): operand and executed case. */
export const IDENTIFIER_BEARING: Readonly<
  Partial<Record<CommandName, readonly [operand: string, kase: keyof typeof CASE]>>
> = {
  'task.cancel': ['lineageId and recordId', 'control'],
  'task.restart': ['lineageId and recordId', 'control'],
  'task.restore': ['batchId', 'control'],
  'grant.revoke': ['grantId', 'control'],
  'delegation.revoke': ['delegationId', 'control'],
  'task.decide': ['gateId', 'gate'],
  'task.board': ['board', 'board'],
  'task.heartbeat': ['leaseId', 'agent'],
  'task.handback': ['leaseId', 'agent'],
  'task.pickup': ['reservationId', 'pickup'],
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
