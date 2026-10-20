// SPDX-License-Identifier: AGPL-3.0-only
//
// The run worker's write operands (`task.observe`, `task.check`, `model.call`),
// moved from `write-operands.ts` to keep it under its line cap; it spreads them
// back in. A model call sends fields, or a model turn (#1623 R3):
// `model-call-operands.ts` reads which.

import type { CommandName } from './command-names.ts';

/** The operand kinds these use, a narrowing of `write-operands.ts`'s `Operand`. */
type Spec = Readonly<Record<string, 'any' | 'any?'>>;

export const AGENT_RUN_OPERANDS: Readonly<Partial<Record<CommandName, Spec>>> = {
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
  'model.call': {
    leaseId: 'any',
    fence: 'any',
    operation: 'any',
    fields: 'any?',
    kind: 'any?',
    turnOrdinal: 'any?',
    tools: 'any?',
    parts: 'any?',
  },
};
