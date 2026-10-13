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

/** A JSON value's strings in document order, and everything else it spells (keys, numbers, literals). */
function leavesOf(decoded: unknown): { readonly strings: string[]; readonly others: string[] } {
  const strings: string[] = [];
  const others: string[] = [];
  const pending: unknown[] = [decoded];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') strings.push(value);
    else if (typeof value === 'object' && value !== null) {
      const items = Array.isArray(value) ? (value as unknown[]) : Object.values(value);
      if (!Array.isArray(value)) others.push(...Object.keys(value));
      for (let at = items.length - 1; at >= 0; at -= 1) pending.push(items[at]);
    } else others.push(JSON.stringify(value));
  }
  return { strings, others };
}

/** A text as sent, base64 or base64url decoded (line breaks ignored), and percent-decoded. */
function readingsOf(text: string): readonly string[] {
  let decoded = '';
  try {
    decoded = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  } catch {
    // Not base64: nothing to read that way.
  }
  const unescaped = text.replaceAll(/%([0-9A-Fa-f]{2})/gu, (_, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
  return [text, decoded, unescaped];
}

/**
 * The shortest piece of a secret, or of its base64, an answer string may not
 * hold. The caller keeps only its schema's few declared fields and may join
 * them in any order, so a secret split across them leaves at least one field
 * holding a piece this long: a secret of 40 characters or more over up to five.
 */
const PIECE = 8;

/** Every `PIECE`-long run of each secret and of its base64 spellings; a shorter form whole. */
function piecesOf(secrets: readonly string[]): { runs: ReadonlySet<string>; whole: string[] } {
  const runs = new Set<string>();
  const whole: string[] = [];
  for (const form of secrets.flatMap((secret) => [secret, ...base64Spellings(secret)])) {
    if (form.length < PIECE) whole.push(form);
    for (let at = 0; at + PIECE <= form.length; at += 1) runs.add(form.slice(at, at + PIECE));
  }
  return { runs, whole };
}

/** Whether a text, as given or with its whitespace removed, holds any piece. */
function holdsPiece(text: string, { runs, whole }: ReturnType<typeof piecesOf>): boolean {
  return [text, text.replaceAll(/\s/gu, '')].some((one) => {
    if (whole.some((form) => form !== '' && one.includes(form))) return true;
    for (let at = 0; at + PIECE <= one.length; at += 1) {
      if (runs.has(one.slice(at, at + PIECE))) return true;
    }
    return false;
  });
}

/**
 * Whether an answer carries the credential: any spelling `redact` removes, or
 * inside any one of a JSON answer's strings, read as sent, base64 decoded (line
 * breaks ignored) or percent-decoded, a piece of the secret or of its base64
 * (`PIECE`), so a secret split across fields is caught in any order and past
 * any field between. A destination that refuses echoes withholds such an
 * answer whole. An arbitrary transform stays out of reach; the credential's own
 * scope bounds that.
 */
export function echoes(text: string, credential: StoredCredential): boolean {
  const secrets = secretsOf(credential);
  const redactText = redacterOf(secrets);
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return redactText(text) !== text;
  }
  const { strings, others } = leavesOf(decoded);
  if (others.some((one) => redactText(one) !== one)) return true;
  const pieces = piecesOf(secrets);
  return strings.some(
    (one) =>
      redactText(one) !== one || readingsOf(one).some((reading) => holdsPiece(reading, pieces)),
  );
}
