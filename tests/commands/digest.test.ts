// SPDX-License-Identifier: AGPL-3.0-only
//
// The repeat-request identity rests on one comparison: is this the same
// payload as last time? So the canonical form is the thing under test, and
// what it must refuse matters as much as what it accepts.

import { describe, expect, it } from 'vitest';
import {
  canonicalPayload,
  payloadDigest,
} from '../../packages/core-records/src/commands/digest.ts';

describe('the canonical payload', () => {
  it('reads the same for two objects whose keys arrived in a different order', () => {
    const left = canonicalPayload({ title: 'a', due: null, board: 'b' });
    const right = canonicalPayload({ board: 'b', title: 'a', due: null });
    expect(left).toBe(right);
  });

  it('goes all the way down, not one level', () => {
    const left = canonicalPayload({ fields: { b: 1, a: [{ y: 2, x: 1 }] } });
    const right = canonicalPayload({ fields: { a: [{ x: 1, y: 2 }], b: 1 } });
    expect(left).toBe(right);
  });

  it('keeps array order, because a list is not a set', () => {
    expect(canonicalPayload([1, 2])).not.toBe(canonicalPayload([2, 1]));
  });

  it('tells an absent key from an explicit null, because the two are different requests', () => {
    expect(canonicalPayload({ due: null })).not.toBe(canonicalPayload({}));
  });

  it('refuses a value it cannot canonicalise rather than digesting a guess', () => {
    expect(() => canonicalPayload({ when: new Date(0) })).toThrow(/canonicalPayload/u);
    expect(() => canonicalPayload({ n: Number.NaN })).toThrow(/canonicalPayload/u);
    expect(() => canonicalPayload({ n: 1n })).toThrow(/canonicalPayload/u);
    expect(() => canonicalPayload({ f: () => 1 })).toThrow(/canonicalPayload/u);
  });

  it('drops an undefined member, so an optional field left off reads as left off', () => {
    expect(canonicalPayload({ a: 1, b: undefined })).toBe(canonicalPayload({ a: 1 }));
  });
});

describe('the digest', () => {
  it('is a sha-256 hex digest, so its length says which algorithm made it', () => {
    expect(payloadDigest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('differs for two payloads that differ anywhere', () => {
    expect(payloadDigest({ a: 1 })).not.toBe(payloadDigest({ a: 2 }));
  });

  it('covers the command, so one identity cannot be used for two of them', () => {
    // This is what the repeat-request register leans on when it refuses
    // `OPERATION_ID_REUSED` across commands: there is no second comparison of
    // the command name, because the name is inside the compared payload.
    expect(payloadDigest({ command: 'task.complete', recordId: 'r' })).not.toBe(
      payloadDigest({ command: 'task.reopen', recordId: 'r' }),
    );
  });

  it('is stable across calls, or the register would refuse every honest retry', () => {
    expect(payloadDigest({ a: [1, { b: 'x' }] })).toBe(payloadDigest({ a: [1, { b: 'x' }] }));
  });
});
