// SPDX-License-Identifier: AGPL-3.0-only
//
// After a lost answer the publish reads back before anything else: a landing is
// the answer, proof of absence allows one more send, anything else stays
// unknown. The second send is read back too, so a landing whose answer was lost
// again is still found, and two sends that never landed end `unknown`
// (`ADVANCE_NOT_LANDED`), never a third send. Mutants that turn it red: remove
// the read back after the second send; allow a third send.

import { expect, it } from 'vitest';
import { publishCorrection } from '../../packages/core-connectors/src/index.ts';
import {
  LANDED,
  absent,
  job,
  landed,
  scripted,
  timeout,
  unread,
  type Script,
} from './advance-attempts.ts';

const answered = { kind: 'ok', value: LANDED } as const;

const cases: readonly (readonly [string, Script, number, Record<string, string>])[] = [
  [
    'the first answer lost, landed',
    { sends: [timeout], backs: [absent, landed] },
    1,
    { state: 'accepted' },
  ],
  [
    'the first lost and not landed, the second answered',
    { sends: [timeout, answered], backs: [absent, absent] },
    2,
    { state: 'accepted' },
  ],
  [
    'the first lost, the second landed with its answer lost',
    { sends: [timeout, timeout], backs: [absent, absent, landed] },
    2,
    { state: 'accepted' },
  ],
  [
    'both lost, neither landed',
    { sends: [timeout, timeout], backs: [absent, absent, absent] },
    2,
    { state: 'unknown', code: 'ADVANCE_NOT_LANDED' },
  ],
  [
    'both lost, the last read back unreadable',
    { sends: [timeout, timeout], backs: [absent, absent, unread] },
    2,
    { state: 'unknown', code: 'RECONCILE_UNPROVEN' },
  ],
  [
    'the first lost, its read back unreadable',
    { sends: [timeout], backs: [absent, unread] },
    1,
    { state: 'unknown', code: 'RECONCILE_UNPROVEN' },
  ],
];

it.each(cases)('%s', async (_, script, sends, outcome) => {
  const ports = scripted(script);
  expect(await publishCorrection(job(), ports)).toMatchObject(outcome);
  expect(ports.sent()).toBe(sends);
});
