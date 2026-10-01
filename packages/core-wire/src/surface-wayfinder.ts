// SPDX-License-Identifier: AGPL-3.0-only
//
// The wayfinder commands' operands (WF-1, WF-2), spread into `surface.ts`'s
// write operand table, which checks each against its `OperandSpec`.

const TARGET = { recordId: 'id' } as const;

/** The two operand kinds these use, a narrowing of `surface.ts`'s `Operand`. */
type Spec = Readonly<Record<string, 'id' | 'any'>>;

export const WAYFINDER_OPERANDS: Readonly<Record<string, Spec>> = {
  'task.set_type': { ...TARGET, taskType: 'any' },
  'map.revise': {
    ...TARGET,
    destination: 'any',
    notes: 'any',
    addFog: 'any',
    addOutOfScope: 'any',
    retire: 'any',
  },
  'map.scope': { ...TARGET, client: 'any' },
  'map.chart': {
    title: 'any',
    destination: 'any',
    notes: 'any',
    tickets: 'any',
    fog: 'any',
    outOfScope: 'any',
    preAnswers: 'any',
  },
  'task.set_blocking': { ...TARGET, blockedBy: 'any' },
  'task.claim': TARGET,
  'map.graduate': { ...TARGET, patchId: 'any', tickets: 'any' },
  'task.resolve': { ...TARGET, answer: 'any', gist: 'any' },
  'task.close_out_of_scope': { ...TARGET, reason: 'any' },
};
