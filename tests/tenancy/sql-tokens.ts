// SPDX-License-Identifier: AGPL-3.0-only
//
// SQL text as tokens, read the way PostgreSQL reads it (statements.ts
// scanToken), for migration-column-grants.ts: comments dropped, unquoted words
// folded to lower case, and every string's value decoded, E'' and U&''
// escapes included, so text spelt with escapes reads as what the server runs.

import { scanToken } from '../../packages/core-records/src/tenancy/statements.ts';

export interface Token {
  /**
   * `word` is folded to lower case; `name` is a quoted identifier, unquoted;
   * `quoted` holds a string's or a dollar-quoted body's value, escapes decoded.
   */
  readonly kind: 'word' | 'name' | 'quoted' | 'other';
  readonly text: string;
}

const SPACE = /^[ \t\n\r\f\v]$/u;

/** An E'' string's escapes (PostgreSQL's lexical rules, "String Constants with C-Style Escapes"). */
const C_ESCAPE =
  /\\(?:([0-7]{1,3})|x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|([\s\S]))/gu;
const NAMED: Readonly<Record<string, string>> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
/** A U&'' string's escapes, with the default escape character. */
const UNICODE_ESCAPE = /\\(?:\+([0-9A-Fa-f]{6})|([0-9A-Fa-f]{4})|(\\))/gu;

/** A string's value: each quoted run, quotes undoubled, continuations joined, escapes decoded. */
function stringValue(text: string, escapes: 'c' | 'unicode' | 'none'): string {
  // A backslash escapes a quote only in an E'' string.
  const quotedRun = escapes === 'c' ? /'((?:[^'\\]|''|\\[\s\S])*)'/gu : /'((?:[^']|'')*)'/gu;
  const runs = [...text.matchAll(quotedRun)].map((match) => match[1] ?? '');
  const joined = runs.map((run) => run.replaceAll("''", "'")).join('');
  if (escapes === 'c') {
    return joined.replaceAll(C_ESCAPE, (_, oct, hex, u4, u8, other: string | undefined) => {
      const code = oct ?? hex ?? u4 ?? u8;
      const base = oct === undefined ? 16 : 8;
      if (code === undefined) return NAMED[other ?? ''] ?? other ?? '';
      return String.fromCodePoint(Number.parseInt(code, base));
    });
  }
  if (escapes === 'unicode') {
    return joined.replaceAll(
      UNICODE_ESCAPE,
      (_, six, four, slash: string | undefined) =>
        slash ?? String.fromCodePoint(Number.parseInt(six ?? four, 16)),
    );
  }
  return joined;
}

export function tokens(sql: string): Token[] {
  const found: Token[] = [];
  for (let at = 0; at < sql.length;) {
    const token = scanToken(sql, at);
    const text = sql.slice(at, token.end);
    at = token.end;
    if (token.unterminated === true) throw new Error('an unterminated block comment');
    if (token.kind === 'comment' || SPACE.test(text)) continue;
    const unicode = isWord(found.at(-2), 'u') && found.at(-1)?.text === '&';
    if (token.kind === 'word') {
      if (text.toLowerCase() === 'uescape')
        throw new Error('a UESCAPE this reader does not decode');
      found.push({ kind: 'word', text: text.toLowerCase() });
    } else if (token.kind === 'quoted' && text.startsWith('"')) {
      if (unicode) throw new Error('a U& identifier this reader does not decode');
      found.push({ kind: 'name', text: text.slice(1, -1).replaceAll('""', '"') });
    } else if (token.kind === 'quoted' && text.startsWith('$')) {
      found.push({ kind: 'quoted', text: /^(\$[^$]*\$)([\s\S]*)\1$/u.exec(text)?.[2] ?? '' });
    } else if (token.kind === 'quoted') {
      if (unicode) found.splice(-2, 2);
      const escapes = /^[Ee]'/u.test(text) ? 'c' : unicode ? 'unicode' : 'none';
      found.push({ kind: 'quoted', text: stringValue(text, escapes) });
    } else found.push({ kind: token.kind, text });
  }
  return found;
}

export const isWord = (token: Token | undefined, text: string): boolean =>
  token?.kind === 'word' && token.text === text;
