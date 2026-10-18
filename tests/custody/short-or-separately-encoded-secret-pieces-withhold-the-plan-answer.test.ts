// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P3: a held secret cut into three-character pieces and scattered out
// of order, or cut into pieces each base64-encoded on its own, withholds the
// plan answer whole.

import { expect, it } from 'vitest';
import { planAnswer } from '../../packages/core-custody/src/plan-answer.ts';
import {
  ACCESS,
  SECRETS,
  answered,
  completed,
  scrambled,
  stream,
} from './fixtures/plan-answer-world.ts';

it('three-character pieces out of order withhold the answer', () => {
  const pieces = scrambled(ACCESS, 3);
  const result = planAnswer(answered(stream(completed(pieces))), SECRETS);
  if (result.ok) {
    const returned = JSON.stringify(result.response);
    for (const piece of pieces) expect(returned).toContain(piece);
  }
  expect(result).toMatchObject({ ok: false, code: 'SUBSCRIPTION_ANSWER_WITHHELD' });
});

it('pieces encoded one by one, decoded and joined, withhold the answer', () => {
  const pieces = Array.from({ length: Math.ceil(ACCESS.length / 3) }, (_, at) =>
    ACCESS.slice(at * 3, at * 3 + 3),
  );
  const encoded = pieces.map((piece) => Buffer.from(piece).toString('base64'));
  expect(encoded.map((piece) => Buffer.from(piece, 'base64').toString()).join('')).toBe(ACCESS);
  const result = planAnswer(answered(stream(completed(encoded))), SECRETS);
  expect(result).toMatchObject({ ok: false, code: 'SUBSCRIPTION_ANSWER_WITHHELD' });
});
