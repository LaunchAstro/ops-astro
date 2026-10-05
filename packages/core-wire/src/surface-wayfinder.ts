// SPDX-License-Identifier: AGPL-3.0-only
//
// The wayfinder commands' operands (WF-1), spread into `surface.ts`'s write
// operand table, which checks each against its `OperandSpec`, and their map
// lock, which `surface.ts` imports (moved whole to keep it under its line cap).

/**
 * The key every write to a map's structure serialises on, taken before any
 * task row: no two writes hold a map and a ticket in opposite orders.
 */
export const WAYFINDER_MAP_LOCK = 'wayfinder.map';

const TARGET = { recordId: 'id' } as const;

/** The two operand kinds these use, a narrowing of `surface.ts`'s `Operand`. */
type Spec = Readonly<Record<string, 'id' | 'any'>>;

export const WAYFINDER_OPERANDS: Readonly<Record<string, Spec>> = {
  'task.set_type': { ...TARGET, taskType: 'any' },
  'map.scope': { ...TARGET, client: 'any' },
};
