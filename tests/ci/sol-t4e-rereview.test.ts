// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  PARTS,
  classify,
  everyInvariantBites,
  lineOf,
  type CaseLine,
} from './self-test/mutations.ts';

const pass = (name: string): CaseLine => ({ case: name, status: 'pass', detail: 'ran and passed' });
const complete = (): CaseLine[] => [
  pass('T4-N1 a deleted migration fails the migration check'),
  pass('T4-N2 an operation with no isolation case fails the isolation matrix'),
  pass('T4-N3 a registry entry with no screen fails the route registry check'),
  pass('T4-N3 a duplicate route id fails the typecheck'),
  pass('T4-N3 a changed pinned-mockup byte fails the mockup pin'),
  pass('control: the isolation matrix'),
  pass('control: the route registry check'),
  pass('control: the typecheck'),
  ...PARTS.flatMap((part) => [
    pass(`control: ${part.id} ${part.invariants.join(', ')}`),
    pass(`${lineOf(part)} ${part.planted === undefined ? 'reverted' : 'planted'}`),
  ]),
];

describe('T4e range re-review proofs', () => {
  it('Sol proof, criterion 2: three copies of one T4-N3 result do not replace its other mutations', () => {
    const lines = complete();
    const first = lines.find((line) => line.case.startsWith('T4-N3'));
    if (first === undefined) throw new Error('missing T4-N3 setup');
    const duplicated = lines.map((line) => (line.case.startsWith('T4-N3') ? first : line));
    expect(everyInvariantBites(duplicated).status).toBe('fail');
  });

  it('Sol proof, criterion 2: missing unmutated controls fail the whole verdict', () => {
    const withoutControls = complete().filter((line) => !line.case.startsWith('control:'));
    expect(everyInvariantBites(withoutControls).status).toBe('fail');
  });

  it('Sol proof, criterion 3: a green client and person crossing fails the T3b revert by name', () => {
    const verdict = classify('T4-N4 T3b reverted: unknown_stays_unknown', {
      applied: true,
      executed: 2,
      red: true,
      detail: '1 of 2 cases failed',
      cases: [
        { name: 'unknown_stays_unknown: swept liability', passed: false },
        {
          name: 'client to client and person to person: the unknown amount reaches only a reader holding the task grant',
          passed: true,
        },
      ],
    });
    expect(verdict.status).toBe('fail');
    expect(verdict.detail).toContain('client to client and person to person');
  });
});
