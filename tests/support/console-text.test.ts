// SPDX-License-Identifier: AGPL-3.0-only
//
// The text a console capture reads must hold every value the call carried, at
// any depth (catalogue #720), or a secret logged inside an object passes the
// no-secret check unseen.

import { format } from 'node:util';
import { expect, it } from 'vitest';
import { consoleLine, streamText } from './console-text.ts';

const planted = 'console-text-planted-value';

it('keeps a value logged inside an object, however deep', () => {
  const deep = { a: { b: { c: { d: { e: { credential: planted } } } } } };
  expect(consoleLine({ credential: planted })).toContain(planted);
  expect(consoleLine('fault', deep)).toContain(planted);
});

it('keeps a value inside an array, a map, a set and an error cause', () => {
  const many = Array.from({ length: 200 }, (_, index) => `n${String(index)}`);
  expect(consoleLine([...many, planted])).toContain(planted);
  expect(consoleLine(new Map([['k', { planted }]]))).toContain(planted);
  expect(consoleLine(new Set([planted]))).toContain(planted);
  expect(consoleLine(new Error('outer', { cause: { planted } }))).toContain(planted);
});

it('keeps a long string whole', () => {
  expect(consoleLine({ text: `${'x'.repeat(20_000)}${planted}` })).toContain(planted);
});

it('writes plain strings as the console does, unquoted and space-joined', () => {
  expect(consoleLine('one', 'two', 3)).toBe('one two 3');
});

it('formats percent directives on plain values as the console does', () => {
  const calls: readonly (readonly unknown[])[] = [
    ['a %s b', 'x'],
    ['%d%%', 5],
    ['%%s %s', 'x'],
    ['%s %s', 'one'],
    ['%j', { a: 1 }],
    ['%c%s', 'color: red', 'x'],
    ['%i %f', 1.5, 2.5],
    ['%q %s', 'x', 'extra'],
  ];
  for (const call of calls) expect(consoleLine(...call)).toBe(format(...call));
});

it('writes an object with its own toString under percent-s as that text', () => {
  class Key {
    readonly #value = planted;
    toString(): string {
      return this.#value;
    }
  }
  expect(consoleLine('key=%s', new Key())).toBe(`key=${planted}`);
  expect(consoleLine('key=%s', { [Symbol.toPrimitive]: () => planted })).toBe(`key=${planted}`);
});

it('keeps the rest of a call that also logs a revoked proxy', () => {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  expect(consoleLine('token %s', planted, revocable.proxy)).toContain(planted);
  expect(consoleLine(revocable.proxy, planted)).toContain(planted);
  const bytes = Buffer.from('bytes');
  const throwing = new Proxy(Buffer.prototype, {
    getPrototypeOf: () => {
      throw new Error('trap');
    },
  });
  Object.setPrototypeOf(bytes, throwing);
  expect(consoleLine('a %s b %s', bytes, planted)).toContain(planted);
  const deep = { a: { b: { c: { d: { e: { bytes } } } } } };
  expect(consoleLine('%o %s', deep, planted)).toContain(planted);
  expect(consoleLine('%O %s', deep, planted)).toContain(planted);
  expect(consoleLine(deep, planted)).toContain(planted);
  expect(consoleLine('%s', planted, deep)).toContain(planted);
});

it('keeps what a Buffer carries beyond its bytes', () => {
  const tagged = Object.assign(Buffer.from('x'), { token: planted });
  expect(consoleLine(tagged)).toContain(planted);
  expect(consoleLine('%O', tagged)).toContain(planted);
  expect(consoleLine('%o', tagged)).toContain(planted);
  const hiding = Buffer.from('x');
  Object.defineProperty(hiding, 'token', { value: planted });
  expect(consoleLine('%o', hiding)).toContain(planted);
});

it('writes a proxy that claims to be a Buffer as the console does, through to its target', () => {
  const claiming = new Proxy({ token: planted }, { getPrototypeOf: () => Buffer.prototype });
  expect(consoleLine(claiming)).toContain(planted);
  expect(consoleLine('%s', claiming)).toContain(planted);
  expect(consoleLine('%O', claiming)).toContain(planted);
  expect(consoleLine('x', claiming)).toContain(planted);
  expect(() => consoleLine('%o', new Proxy(Buffer.from(planted), {}))).not.toThrow();
});

it('writes an error with its stack', () => {
  const error = new Error(planted);
  expect(consoleLine(error)).toContain(String(error.stack));
});

it('reads a stream write as the terminal shows it, bytes decoded as text', () => {
  expect(streamText(planted)).toBe(planted);
  expect(streamText(Buffer.from(planted))).toBe(planted);
  expect(streamText(new TextEncoder().encode(planted))).toBe(planted);
});
