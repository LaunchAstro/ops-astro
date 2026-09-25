// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1, lane FR1-API-SIGN, the signing half.
//
// R1-RUNTIME-50: a signature is verified in its one canonical spelling, 64
// lowercase hex characters. `Buffer.from(s, 'hex')` decodes case-insensitively
// and stops at the first non-hex character, so an uppercased signature, one
// with trailing junk or one with an odd trailing nibble used to verify.
//
// R1-RUNTIME-51: a stored decision payload that is not a JSON object (null, a
// string, a number, an array) declares no link version. It answers
// `undefined`, which the read turns into `DECISION_INTEGRITY`, rather than
// throwing a `TypeError` that the server answers as a retryable 503.
//
// R1-RUNTIME-52: an own `__proto__` key, which `JSON.parse` creates, is part
// of what the canonical text and the digest cover, at every depth.

import { describe, expect, it } from 'vitest';
import {
  canonicalise,
  digestOf,
  linkVersionOf,
  sign,
  verify,
} from '../../packages/core-runtime/src/signing.ts';

const KEY = { id: 'final-r1-api-sign', secret: 'a-test-only-signing-secret' };
const DIGEST = digestOf({ link: 3, note: 'approve' });

describe('R1-RUNTIME-50: verify accepts only the canonical signature text', () => {
  const signature = sign(KEY, DIGEST);

  it('accepts the signature as sign wrote it', () => {
    expect(signature).toMatch(/^[0-9a-f]{64}$/u);
    expect(verify(KEY, DIGEST, signature)).toBe(true);
  });

  it.each([
    ['uppercased', signature.toUpperCase()],
    ['with trailing non-hex', `${signature}zz`],
    ['with an odd trailing nibble', `${signature}0`],
    ['with leading whitespace', ` ${signature}`],
    ['truncated', signature.slice(0, 62)],
    ['empty', ''],
  ])('refuses the signature %s', (_label, altered) => {
    expect(verify(KEY, DIGEST, altered)).toBe(false);
  });
});

describe('R1-RUNTIME-51: a non-object payload declares no link version', () => {
  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a number', 1],
    ['a boolean', true],
    ['an array', [{ link: 3 }]],
  ])('answers undefined for %s rather than throwing', (_label, payload) => {
    expect(() => linkVersionOf(payload)).not.toThrow();
    expect(linkVersionOf(payload)).toBeUndefined();
  });

  it('still reads the versions it knows from an object', () => {
    expect(linkVersionOf({})).toBe(1);
    expect(linkVersionOf({ link: 2 })).toBe(2);
    expect(linkVersionOf({ link: 3 })).toBe(3);
    expect(linkVersionOf({ link: 4 })).toBeUndefined();
  });
});

describe('R1-RUNTIME-52: canonicalise covers own __proto__ keys', () => {
  it('writes an own __proto__ member rather than dropping it', () => {
    expect(canonicalise(JSON.parse('{"__proto__":{"a":1}}'))).toBe('{"__proto__":{"a":1}}');
  });

  it('sorts an own __proto__ member among its siblings, at depth', () => {
    const value = JSON.parse('{"z":1,"note":{"text":"t","__proto__":{"b":2,"a":1}}}');
    expect(canonicalise(value)).toBe('{"note":{"__proto__":{"a":1,"b":2},"text":"t"},"z":1}');
  });

  it('gives a payload altered only under __proto__ a different digest', () => {
    const original = JSON.parse('{"link":3,"note":{"__proto__":{"text":"approve 10"}}}');
    const altered = JSON.parse('{"link":3,"note":{"__proto__":{"text":"approve 10000"}}}');
    expect(digestOf(altered)).not.toBe(digestOf(original));
  });

  it('leaves the canonical text of a payload without __proto__ unchanged', () => {
    expect(canonicalise({ b: [2, { d: 1, c: 0 }], a: null })).toBe(
      '{"a":null,"b":[2,{"c":0,"d":1}]}',
    );
  });

  it('does not reach the prototype of the value it builds', () => {
    const canonical = JSON.parse(canonicalise(JSON.parse('{"__proto__":{"polluted":true}}')));
    expect(Object.getPrototypeOf(canonical)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
