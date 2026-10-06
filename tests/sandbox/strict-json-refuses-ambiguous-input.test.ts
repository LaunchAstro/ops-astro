// SPDX-License-Identifier: AGPL-3.0-only
//
// The sandbox contract's one JSON parser (docs/plan/sandbox-contract.md, the
// preamble and P1): every request body and every daemon reply goes through
// it. Duplicate keys at any depth, more than 1 MiB and more than 32 levels
// are refused; for a request, so is a key that differs from another only in
// ASCII case, since Docker's decoder matches keys without regard to case.

import { expect, it } from 'vitest';
import { parseStrictJson } from '../../packages/core-sandbox/src/strict-json.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const nest = (depth: number): string => '['.repeat(depth) + ']'.repeat(depth);
const objects = (depth: number): string => '{"a":'.repeat(depth) + '0' + '}'.repeat(depth);

it('reads a well-formed object, keeping key order and value types', () => {
  const parsed = parseStrictJson(
    bytes('{"Id":"a","Count":3,"Ok":true,"None":null,"List":[1.5,-2.5e-3,9007199254740991]}'),
  );
  expect(parsed).toEqual({
    ok: true,
    value: { Id: 'a', Count: 3, Ok: true, None: null, List: [1.5, -0.0025, 9007199254740991] },
  });
});

it.each([
  ['a duplicate key at the top', '{"a":1,"a":2}'],
  ['a duplicate key three levels down', '{"x":{"y":{"z":1,"z":1}}}'],
  ['a duplicate key inside an array element', '[{"k":1},{"k":1,"k":2}]'],
])('refuses %s', (_name, text) => {
  expect(parseStrictJson(bytes(text))).toMatchObject({ ok: false, why: 'duplicate key' });
});

it('refuses keys equal after ASCII case folding when folding is asked for, and only then', () => {
  expect(parseStrictJson(bytes('{"Image":"a","image":"b"}'), { foldCase: true })).toMatchObject({
    ok: false,
    why: 'duplicate key',
  });
  expect(parseStrictJson(bytes('{"Image":"a","image":"b"}'))).toMatchObject({ ok: true });
});

it('refuses a non-ASCII key in a request, which Go would fold onto an ASCII one, and only then', () => {
  for (const key of ['Ho\u017Ft', 'Linu\u212A']) {
    expect(parseStrictJson(bytes(`{"${key}":1}`), { foldCase: true })).toMatchObject({ ok: false });
    expect(parseStrictJson(bytes(`{"${key}":1}`))).toMatchObject({ ok: true });
  }
});

it('takes exactly 32 levels and refuses 33', () => {
  expect(parseStrictJson(bytes(nest(32)))).toMatchObject({ ok: true });
  expect(parseStrictJson(bytes(nest(33)))).toMatchObject({ ok: false, why: 'too deep' });
});

it('refuses 33 nested objects, and 150,000 of them without overflowing the stack', () => {
  expect(parseStrictJson(bytes(objects(32)))).toMatchObject({ ok: true });
  expect(parseStrictJson(bytes(objects(33)))).toMatchObject({ ok: false, why: 'too deep' });
  expect(parseStrictJson(bytes(objects(150_000)))).toMatchObject({ ok: false, why: 'too deep' });
});

it('takes exactly 1 MiB and refuses one byte more', () => {
  const at = `"${'a'.repeat(1024 * 1024 - 2)}"`;
  expect(parseStrictJson(bytes(at))).toMatchObject({ ok: true });
  expect(parseStrictJson(bytes(`${at} `))).toMatchObject({ ok: false, why: 'too large' });
});

it('takes a larger cap only when the caller names one, and refuses one byte past it', () => {
  const cap = 2 * 1024 * 1024;
  const at = `"${'a'.repeat(cap - 2)}"`;
  expect(parseStrictJson(bytes(at), { maxBytes: cap })).toMatchObject({ ok: true });
  expect(parseStrictJson(bytes(`${at} `), { maxBytes: cap })).toMatchObject({
    ok: false,
    why: 'too large',
  });
  expect(parseStrictJson(bytes(at))).toMatchObject({ ok: false, why: 'too large' });
});

it.each([
  ['a byte-order mark', '\uFEFF{}'],
  ['a trailing comma', '{"a":1,}'],
  ['a single-quoted string', "{'a':1}"],
  ['a bare control character in a string', '"a\u0001b"'],
  ['a lone surrogate escape', '"\\ud800"'],
  ["an escape that is not one of JSON's", '"\\x0041"'],
  ['a unicode escape with non-hex digits', '"\\u12zz"'],
  ['a low surrogate first', '"\\udc00\\udc00"'],
  ['a high surrogate followed by text, not an escape', '"\\ud800xxdc00"'],
  ['a misspelt literal', '[trux]'],
  ['a key with no colon', '{"a"x1}'],
  ['a high surrogate followed by an escape above the low range', '"\\ud800\\ue000"'],
  ['a high surrogate followed by an escape outside the low range', '"\\ud800\\u0041"'],
  ['a leading zero', '[01]'],
  ['a plus sign', '[+1]'],
  ['NaN', '[NaN]'],
  ['a number too large for a double', '[1e400]'],
  ['an integer written with a fraction', '[1.0]'],
  ['an integer written with an exponent', '[1e3]'],
  ['a fraction a double rounds to an integer', '[1073741824.00000000001]'],
  ['a number that underflows to zero', '[1e-400]'],
  ['an integer past 2^53', '[9007199254740993]'],
  ['a second value after the first', '{} {}'],
  ['a comment', '{/*c*/}'],
  ['an unterminated array', '[1'],
  ['an unterminated string', '"abc'],
  ['nothing at all', ''],
])('refuses %s', (_name, text) => {
  expect(parseStrictJson(bytes(text))).toMatchObject({ ok: false, reason: 'internal' });
});

it('reads every simple escape and a plain unicode escape', () => {
  const text = '"\\"\\\\\\/\\b\\f\\n\\r\\t\\u0041\\u00e9\\ue000"';
  expect(parseStrictJson(bytes(text))).toEqual({ ok: true, value: '"\\/\b\f\n\r\tA\u00E9\uE000' });
});

it('reads an escaped surrogate pair as one character', () => {
  expect(parseStrictJson(bytes('"\\ud83d\\ude00"'))).toEqual({ ok: true, value: '\u{1F600}' });
});

it('refuses bytes that are not UTF-8', () => {
  expect(parseStrictJson(new Uint8Array([0x22, 0xff, 0x22]))).toMatchObject({ ok: false });
});

it('keeps a key named __proto__ as data, never as the prototype', () => {
  const parsed = parseStrictJson(bytes('{"__proto__":{"polluted":true}}'));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(Object.keys(parsed.value as object)).toEqual(['__proto__']);
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
});
