// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody's redaction of an answer (AW-01): every spelling of the credential
// a provider might echo back becomes `[redacted]`, in plain text and inside a
// JSON answer's keys and values. Custody's process loads it, so it imports no
// connector or database code.

import type { StoredCredential } from './credentials.ts';
import { cut, spans, spellingsOf } from './secret-spellings.ts';

/**
 * The secret's base64, standard and base64url, at each of the three byte
 * offsets it can sit at inside longer encoded text: only the characters every
 * bit of which comes from the secret, so neighbouring bytes cannot change
 * them. A whole encoding alone, padded or not, contains the offset-0 one.
 */
function base64Spellings(secret: string): readonly string[] {
  const bytes = Buffer.from(secret);
  return [0, 1, 2].flatMap((offset) => {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64');
    const stable = encoded.slice(
      Math.ceil((8 * offset) / 6),
      Math.floor((8 * (offset + bytes.length)) / 6),
    );
    return [stable, stable.replaceAll('+', '-').replaceAll('/', '_')];
  });
}

/**
 * Text with every spelling of each secret replaced by `[redacted]`. The
 * spellings are worked out once, so a JSON answer of many small values costs
 * its length, not a setup per value.
 */
export function redacterOf(secrets: readonly string[]): (text: string) => string {
  const spelled = secrets.map((secret) => [...secret].map((character) => spellingsOf(character)));
  const encoded = secrets.flatMap((secret) => base64Spellings(secret));
  // Every spelling is at least as long as its secret, so shorter text holds none.
  const shortest = Math.min(...secrets.map((secret) => secret.length));
  return (text) => {
    if (text.length < shortest) return text;
    const unescaped = cut(
      text,
      spelled.flatMap((groups) => spans(text, groups)),
    );
    return encoded.reduce((out, spelling) => out.split(spelling).join('[redacted]'), unescaped);
  };
}

/** What a credential can be echoed as: the value, and a Basic pair's secret half alone. */
export const secretsOf = ({ scheme, value }: StoredCredential): readonly string[] =>
  scheme === 'basic' ? [value, value.split(':')[1] ?? value] : [value];

/** Percent escapes decoded, each byte as one character. */
const unpercent = (text: string): string =>
  text.replaceAll(/%([0-9A-Fa-f]{2})/gu, (_, code: string) =>
    String.fromCodePoint(Number.parseInt(code, 16)),
  );

/**
 * A kept value read the ways the caller could read it: as sent; packed for
 * base64 (whitespace removed, base64url's alphabet as base64's); base64 or
 * base64url decoded, padding allowed; and percent-decoded.
 */
function readingsOf(text: string): readonly string[] {
  const packed = text.replaceAll(/\s/gu, '').replaceAll('-', '+').replaceAll('_', '/');
  const decoded = /^[A-Za-z0-9+/]+={0,2}$/u.test(packed)
    ? Buffer.from(packed, 'base64').toString('latin1')
    : '';
  return [text, packed, decoded, unpercent(text)];
}

/** A secret as itself, in base64 or base64url at any byte offset, and percent-escaped whole. */
function echoSpellings(secret: string): readonly string[] {
  const escaped = [...Buffer.from(secret)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`);
  const lower = escaped.join('');
  return [secret, ...base64Spellings(secret), lower, lower.toUpperCase()].filter(
    (spelling) => spelling.length >= secret.length,
  );
}

/** Every order of every choice of at least two of `count` values, by index. */
function* orders(count: number, taken: readonly number[] = []): Generator<readonly number[]> {
  if (taken.length >= 2) yield taken;
  for (let at = 0; at < count; at += 1) {
    if (!taken.includes(at)) yield* orders(count, [...taken, at]);
  }
}

/** Every way to take one reading of each value in order. */
function* choices(readings: readonly (readonly string[])[]): Generator<readonly string[]> {
  const [first, ...rest] = readings;
  if (first === undefined) {
    yield [];
    return;
  }
  for (const reading of first) for (const tail of choices(rest)) yield [reading, ...tail];
}

const SEPARATORS = ['', ' ', ',', '\n'];

/**
 * Whether the caller could rebuild the credential from the values it keeps
 * of an answer (a site answer cut to its declared fields, at most four), so
 * custody withholds the answer whole. It could if any secret spelling sits in
 * one value or one reading of it (`readingsOf`), or in a join of some of the
 * values in any order, one reading of each, with no separator, a space, a
 * comma or a newline between them, or in such a join of the values as sent,
 * percent-decoded whole. A spelling across a join reaches only into each
 * value's ends, so a long reading keeps just its ends there, cut apart by a
 * character no spelling holds. A value that resembles the secret, short of a
 * whole spelling, is not withheld.
 */
export function withholds(values: readonly string[], credential: StoredCredential): boolean {
  const spellings = secretsOf(credential).flatMap((secret) => echoSpellings(secret));
  const holds = (text: string): boolean => spellings.some((spelling) => text.includes(spelling));
  const read = values.map((value) => readingsOf(value));
  if (read.some((readings) => readings.some((text) => holds(text)))) return true;
  const reach = Math.max(...spellings.map((spelling) => spelling.length));
  const ends = (text: string): string =>
    text.length <= 2 * reach ? text : `${text.slice(0, reach)}\u0000${text.slice(-reach)}`;
  const sent = values.map((value) => ends(value));
  const pieces = read.map((readings) => readings.map((text) => ends(text)));
  for (const order of orders(values.length)) {
    for (const separator of SEPARATORS) {
      const whole = order.map((at) => sent[at] ?? '').join(separator);
      if (holds(unpercent(whole))) return true;
      for (const chosen of choices(order.map((at) => pieces[at] ?? []))) {
        if (holds(chosen.join(separator))) return true;
      }
    }
  }
  return false;
}

/**
 * The longest spelling of any secret the redacter knows: each character in its
 * longest form (a four-byte character percent-escaped is twelve). Text held
 * back this long can still complete a spelling; none is longer.
 */
export const longestSpelling = (secrets: readonly string[]): number =>
  Math.max(
    ...secrets.map((secret) =>
      [...secret].reduce(
        (length, character) =>
          length + Math.max(...spellingsOf(character).map((spelling) => spelling.text.length)),
        0,
      ),
    ),
  );

/** An own field, as the parse sets it: a `__proto__` key is a field like any other. */
const FIELD = { writable: true, enumerable: true, configurable: true } as const;
const put = (into: object, slot: string | number, value: unknown): void => {
  Object.defineProperty(into, slot, { ...FIELD, value });
};

/**
 * A parsed JSON value with each key and string redacted, and a number or literal spelling a
 * secret as `[redacted]`. It walks its own list, not the call stack, into plain objects, which
 * keep JSON.stringify on its fast writer: any depth the parse and write-back accepted still is.
 */
export function redactedValue(decoded: unknown, redactText: (text: string) => string): unknown {
  const root: unknown[] = [undefined];
  const pending: [unknown, object, string | number][] = [[decoded, root, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [value, into, slot] = next;
    let out: unknown;
    if (typeof value === 'string') {
      out = redactText(value);
    } else if (Array.isArray(value)) {
      const list: unknown[] = Array.from({ length: value.length });
      for (const [at, item] of value.entries()) pending.push([item, list, at]);
      out = list;
    } else if (typeof value === 'object' && value !== null) {
      const record = {};
      const fields: [unknown, object, string][] = [];
      for (const [key, field] of Object.entries(value)) {
        const name = redactText(key);
        put(record, name, null);
        fields.push([field, record, name]);
      }
      // Reversed, so a later field whose redacted name repeats wins, as in the parse.
      for (const field of fields.toReversed()) pending.push(field);
      out = record;
    } else {
      const written = JSON.stringify(value);
      out = redactText(written) === written ? value : '[redacted]';
    }
    put(into, slot, out);
  }
  return root[0];
}

/**
 * The text JSON.stringify writes for a parsed value, from custody's own list rather than the
 * call stack, for an answer nested deeper than the engine's JSON.stringify reaches (5,000
 * levels on Node 24). Pending text is written as it comes; a pending object or array is opened
 * into its text, each object or array inside it left pending in its place.
 */
function writtenDeep(decoded: unknown): string {
  let out = '';
  const pending: (string | object)[] = [
    typeof decoded === 'object' && decoded !== null ? decoded : JSON.stringify(decoded),
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next === 'string') {
      out += next;
      continue;
    }
    const list = Array.isArray(next);
    const pieces: (string | object)[] = [];
    let text = list ? '[' : '{';
    for (const [at, [key, item]] of Object.entries(next).entries()) {
      if (at > 0) text += ',';
      if (!list) text += `${JSON.stringify(key)}:`;
      if (typeof item === 'object' && item !== null) {
        pieces.push(text, item);
        text = '';
      } else {
        text += JSON.stringify(item);
      }
    }
    pieces.push(`${text}${list ? ']' : '}'}`);
    for (const piece of pieces.toReversed()) pending.push(piece);
  }
  return out;
}

/**
 * Remove every spelling of the credential a provider might echo back: the
 * value, and a Basic pair's secret half alone, each as itself, as JSON text
 * spells it, percent-escaped in either case, or in base64 or base64url,
 * alone or inside longer encoded text. A JSON answer is redacted inside each
 * key and value as the broker's parse reads them, then written back, so an
 * escape the provider chose (`\/`, `\u0063`) hides nothing and no match
 * reaches the quotes and commas between values; a number or literal that
 * spells a secret becomes `[redacted]`. Other text is redacted as it came.
 */
export function redact(text: string, credential: StoredCredential): string {
  const redactText = redacterOf(secretsOf(credential));
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return redactText(text);
  }
  const redacted = redactedValue(decoded, redactText);
  try {
    return JSON.stringify(redacted);
  } catch {
    // Deeper than the engine's writer reaches: written from custody's own list instead.
    return writtenDeep(redacted);
  }
}
