// SPDX-License-Identifier: AGPL-3.0-only
//
// The sandbox contract's one JSON parser (docs/plan/sandbox-contract.md,
// the preamble and P1). `JSON.parse` keeps the last of two equal keys, so a
// body read here and a body read by the Docker daemon could disagree; this
// parser refuses that and every other ambiguity instead: duplicate keys at
// any depth, more than 1 MiB, more than 32 levels, input that is not UTF-8,
// a byte-order mark, a lone surrogate, and any number a double cannot hold.
// With `foldCase`, two keys equal after ASCII case folding are duplicates
// too, because Docker's decoder matches keys without regard to case.
//
// A syntax error is `internal`: the caller that parses a launcher request
// turns a refusal into `proxy refused` itself.

import { fault, type Result } from './refusal.ts';

export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export const MAX_JSON_BYTES: number = 1024 * 1024;
export const MAX_JSON_DEPTH: number = 32;

type StopWhy = 'too deep' | 'duplicate key' | 'json syntax';
const STOP = Symbol('stop');
/** Ends the read: the reason travels as the message, marked by its cause. */
const stop = (why: StopWhy): Error => new Error(why, { cause: STOP });

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

class Reader {
  private at = 0;
  private readonly text: string;
  private readonly foldCase: boolean;
  constructor(text: string, foldCase: boolean) {
    this.text = text;
    this.foldCase = foldCase;
  }

  document(): Json {
    const value = this.value(1);
    this.space();
    if (this.at !== this.text.length) throw stop('json syntax');
    return value;
  }

  private space(): void {
    while (' \t\n\r'.includes(this.text[this.at] ?? 'x')) this.at += 1;
  }

  private expect(char: string): void {
    if (this.text[this.at] !== char) throw stop('json syntax');
    this.at += 1;
  }

  private literal(word: string, value: Json): Json {
    if (!this.text.startsWith(word, this.at)) throw stop('json syntax');
    this.at += word.length;
    return value;
  }

  private value(depth: number): Json {
    this.space();
    const char = this.text[this.at];
    if (char === '{') return this.object(depth);
    if (char === '[') return this.array(depth);
    if (char === '"') return this.string();
    if (char === 't') return this.literal('true', true);
    if (char === 'f') return this.literal('false', false);
    if (char === 'n') return this.literal('null', null);
    return this.number();
  }

  private number(): number {
    NUMBER.lastIndex = this.at;
    const match = NUMBER.exec(this.text);
    if (match === null) throw stop('json syntax');
    this.at += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw stop('json syntax');
    return value;
  }

  private string(): string {
    this.expect('"');
    let out = '';
    for (;;) {
      const char = this.text[this.at];
      if (char === undefined || char < ' ') throw stop('json syntax');
      this.at += 1;
      if (char === '"') return out;
      if (char !== '\\') {
        out += char;
        continue;
      }
      out += this.escape();
    }
  }

  private escape(): string {
    const char = this.text[this.at] ?? '';
    this.at += 1;
    const simple = ESCAPES[char];
    if (simple !== undefined) return simple;
    if (char !== 'u') throw stop('json syntax');
    const unit = this.hex4();
    if (unit < 0xd800 || unit > 0xdfff) return String.fromCodePoint(unit);
    if (unit > 0xdbff || !this.text.startsWith('\\u', this.at)) throw stop('json syntax');
    this.at += 2;
    const low = this.hex4();
    if (low < 0xdc00 || low > 0xdfff) throw stop('json syntax');
    return String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00));
  }

  private hex4(): number {
    const digits = this.text.slice(this.at, this.at + 4);
    if (!/^[0-9a-fA-F]{4}$/u.test(digits)) throw stop('json syntax');
    this.at += 4;
    return Number.parseInt(digits, 16);
  }

  private array(depth: number): Json[] {
    if (depth > MAX_JSON_DEPTH) throw stop('too deep');
    this.expect('[');
    const out: Json[] = [];
    this.space();
    if (this.text[this.at] === ']') {
      this.at += 1;
      return out;
    }
    for (;;) {
      out.push(this.value(depth + 1));
      this.space();
      if (this.text[this.at] === ']') {
        this.at += 1;
        return out;
      }
      this.expect(',');
    }
  }

  private object(depth: number): Record<string, Json> {
    if (depth > MAX_JSON_DEPTH) throw stop('too deep');
    this.expect('{');
    // A null prototype keeps a key named __proto__ as data.
    const out = Object.create(null) as Record<string, Json>;
    const seen = new Set<string>();
    this.space();
    if (this.text[this.at] === '}') {
      this.at += 1;
      return out;
    }
    for (;;) {
      this.space();
      const key = this.string();
      const folded = this.foldCase ? key.toLowerCase() : key;
      if (seen.has(folded)) throw stop('duplicate key');
      seen.add(folded);
      this.space();
      this.expect(':');
      out[key] = this.value(depth + 1);
      this.space();
      if (this.text[this.at] === '}') {
        this.at += 1;
        return out;
      }
      this.expect(',');
    }
  }
}

// ignoreBOM keeps a leading byte-order mark in the text, where the grammar refuses it.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function parseStrictJson(
  bytes: Uint8Array,
  options: { readonly foldCase?: boolean } = {},
): Result<{ value: Json }> {
  if (bytes.length > MAX_JSON_BYTES) return fault('too large');
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return fault('not utf-8');
  }
  try {
    return { ok: true, value: new Reader(text, options.foldCase === true).document() };
  } catch (error) {
    if (error instanceof Error && error.cause === STOP) return fault(error.message as StopWhy);
    throw error;
  }
}
