// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R3, the answer digest's depth bound (finding S1900-6). A turn's answer
// is digested at its settlement and again when a later turn binds it. Tool
// calls nested past the bound have no digest, judged from the value's own list
// rather than the call stack, so no depth of provider or agent input throws; a
// shallow answer keeps the digest it always had.

import { expect, it } from 'vitest';
import { answerDigest } from '../../packages/core-custody/src/broker-turn.ts';
import { payloadDigest } from '../../packages/core-digest/src/index.ts';

const nested = (depth: number): unknown => JSON.parse(`${'['.repeat(depth)}0${']'.repeat(depth)}`);
const calls = (args: unknown) => [{ id: 'c1', name: 'task.read', args: { taskId: args } }];

it('tool calls nested 6,000 deep have no digest, and nothing throws', () => {
  expect(answerDigest('Reading.', calls(nested(6000)) as never)).toBeUndefined();
});

it('tool calls just past the bound have no digest; at the bound they keep the canonical one', () => {
  expect(answerDigest('Reading.', calls(nested(62)) as never)).toBeUndefined();
  const kept = calls(nested(61));
  expect(answerDigest('Reading.', kept as never)).toBe(
    payloadDigest({ v: 1, text: 'Reading.', toolCalls: kept }),
  );
});
