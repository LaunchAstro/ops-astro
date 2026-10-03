// SPDX-License-Identifier: AGPL-3.0-only
//
// The wayfinder commands' operands (WF-1), spread into `surface.ts`'s write
// operand table, which checks each against its `OperandSpec`.

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
};
