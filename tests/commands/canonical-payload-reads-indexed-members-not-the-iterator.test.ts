// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { canonicalPayload, payloadDigest } from '../../packages/core-digest/src/digest.ts';

it('array iterators cannot erase indexed members from the digest', () => {
  const members = [1, 2];
  Object.defineProperty(members, Symbol.iterator, { value: function* () {} });
  expect(JSON.stringify(members)).toBe('[1,2]');
  // Either refuse this in-process value or spell its indexed JSON members faithfully.
  let spelling: string;
  try {
    spelling = canonicalPayload(members);
  } catch {
    return;
  }
  expect(spelling).toBe('[1,2]');
  expect(payloadDigest(members)).not.toBe(payloadDigest([]));
});
