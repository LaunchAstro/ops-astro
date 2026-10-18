// SPDX-License-Identifier: AGPL-3.0-only
//
// SQL text as tokens, read the way PostgreSQL reads it (statements.ts
// scanToken), for migration-column-grants.ts: comments dropped, unquoted words
// folded to lower case, and every string's value read. Escapes are refused,
// not decoded: in an E'' or U&'' string any backslash but `\\` (one literal
// backslash, which spells nothing) is an error, so text cannot be spelt with
// escapes past the reader. A setting that changes how strings read is refused
// by migration-column-grants.ts.

import { scanToken } from '../../packages/core-records/src/tenancy/statements.ts';

export interface Token {
  /**
   * `word` is folded to lower case; `name` is a quoted identifier, unquoted;
   * `quoted` holds a string's or a dollar-quoted body's value.
   */
  readonly kind: 'word' | 'name' | 'quoted' | 'other';
  readonly text: string;
}

const SPACE = /^[ \t\n\r\f\v]$/u;

/** Between the parts of a continued string: whitespace and line comments (statements.ts continuationAt). */
const GAP = /(?:[ \t\n\r\f\v]|--[^\n\r]*)*/uy;

/**
 * A string's value: each quoted part, quotes undoubled, continuations joined.
 * Each part is read from where the last one ended, past the gap, so a quote in
 * a comment between parts is not paired. In an E'' or U&'' string, `\\` is
 * one backslash and any other escape is refused.
 */
function stringValue(text: string, escapes: boolean): string {
  // A backslash escapes a quote only in an E'' string.
  const part = /^[Ee]'/u.test(text) ? /'((?:[^'\\]|''|\\[\s\S])*)'/uy : /'((?:[^']|'')*)'/uy;
  const runs: string[] = [];
  let end = text.indexOf("'");
  for (let next = end; ; next = GAP.lastIndex) {
    part.lastIndex = next;
    const match = part.exec(text);
    if (match === null) {
      // A part that never closes runs to the end of the text, as the scanner reads it.
      if (text[next] === "'") {
        runs.push(text.slice(next + 1));
        end = text.length;
      }
      break;
    }
    runs.push(match[1] ?? '');
    end = part.lastIndex;
    GAP.lastIndex = end;
    GAP.exec(text);
  }
  if (end !== text.length) throw new Error('a string this reader cannot split into its parts');
  const joined = runs.map((run) => run.replaceAll("''", "'")).join('');
  if (!escapes) return joined;
  for (const escape of joined.matchAll(/\\[\s\S]?/gu)) {
    if (escape[0] !== '\\\\')
      throw new Error(`a string escape ${escape[0]}, which this reader refuses`);
  }
  return joined.replaceAll('\\\\', '\\');
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
      found.push({ kind: 'quoted', text: stringValue(text, unicode || /^[Ee]'/u.test(text)) });
    } else found.push({ kind: token.kind, text });
  }
  return found;
}

export const isWord = (token: Token | undefined, text: string): boolean =>
  token?.kind === 'word' && token.text === text;
