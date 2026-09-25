// SPDX-License-Identifier: AGPL-3.0-only
//
// FR1-JSONB, the digest half (final review round 1, #11 and #52).
//
// #11: a JSON number too large for a double parses to Infinity, and the
// canonical form refuses it. That throw is why the door (`apps/api/app.ts`)
// refuses such a body `COMMAND_BODY_INVALID` before anything takes a digest.
//
// #52: `JSON.parse` makes `__proto__` an own member. This canonicaliser writes
// entries rather than assigning them, so the member is kept and covered by the
// digest, where the signing canonicaliser once dropped it.

import { describe, expect, it } from 'vitest';
import {
  canonicalPayload,
  payloadDigest,
} from '../../packages/core-records/src/commands/digest.ts';

describe('FR1-JSONB: the canonical payload at its edges', () => {
  it('#11: a number that overflows to Infinity has no canonical form', () => {
    const parsed: unknown = JSON.parse('{"operationId":"op-inf-000001","n":1e400}');
    expect((parsed as { n: number }).n).toBe(Number.POSITIVE_INFINITY);
    expect(() => canonicalPayload(parsed)).toThrow(/payload\.n/u);
  });

  it('#52: an own __proto__ member is written and digested', () => {
    expect(canonicalPayload(JSON.parse('{"__proto__":{"a":1}}'))).toBe('{"__proto__":{"a":1}}');
    const small = JSON.parse('{"link":3,"note":{"__proto__":{"text":"approve 10"}}}');
    const large = JSON.parse('{"link":3,"note":{"__proto__":{"text":"approve 10000"}}}');
    expect(payloadDigest(small)).not.toBe(payloadDigest(large));
  });
});
