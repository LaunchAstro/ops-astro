// SPDX-License-Identifier: AGPL-3.0-only
//
// A sparse array has no JSON spelling of its own: `Array.map` skips its holes,
// so one hole would read as an empty array and two as `[,]`, which is not
// JSON. The canonical form refuses any hole, as it refuses every value it
// cannot spell faithfully, and an empty array keeps its own spelling.

import { describe, expect, it } from 'vitest';
import { canonicalPayload, payloadDigest } from '../../packages/core-digest/src/digest.ts';

describe('the canonical payload and sparse arrays', () => {
  it('an array with a hole has no canonical form, and an empty array keeps its own', () => {
    // oxlint-disable-next-line no-sparse-arrays -- the holes are the case
    const holes: readonly unknown[][] = [[,], [, ,], [1, , 3]];
    for (const sparse of holes) {
      expect(() => canonicalPayload({ list: sparse }), String(sparse.length)).toThrow(
        /payload\.list/u,
      );
    }
    expect(canonicalPayload({ list: [] })).toBe('{"list":[]}');
    expect(payloadDigest({ list: [] })).not.toBe(payloadDigest({ list: [null] }));
  });
});
