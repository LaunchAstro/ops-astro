// SPDX-License-Identifier: AGPL-3.0-only
//
// The change envelope (release decision section 2, D21-2): one file, one
// line, one contiguous word inside one text node, markup and style
// unchanged. It is checked here at proposal time and refused by name, so a
// grown diff never reaches a gate for someone to notice. The captures'
// comparison is `captures.ts`.

import { closingFence } from './fence.ts';

export interface CorrectionTarget {
  readonly path: string;
  readonly word: string;
  readonly replacement: string;
}

export interface ChangedFile {
  readonly path: string;
  /** `null` is a file that did not exist before (a create or the new half of a rename). */
  readonly before: string | null;
  readonly after: string | null;
}

export interface ProposedChange {
  readonly files: readonly ChangedFile[];
}

export interface EnvelopeHeld {
  readonly path: string;
  /** One-based. */
  readonly line: number;
  readonly before: string;
  readonly after: string;
}

export type EnvelopeResult =
  | { readonly ok: true; readonly value: EnvelopeHeld }
  | { readonly ok: false; readonly code: 'CHANGE_ENVELOPE_EXCEEDED'; readonly reason: string };

const exceeded = (reason: string): EnvelopeResult => ({
  ok: false,
  code: 'CHANGE_ENVELOPE_EXCEEDED',
  reason,
});

const ONE_WORD = /^\p{L}+$/u;
/**
 * One path segment, by an explicit allow-list of characters, opening with a letter or digit: no
 * route parameter, escape, `.` or `..`, and no `_` or `.` file Astro leaves out of its routes.
 */
const SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u;
const PAGE_FILE = /\.(?:astro|md)$/u;

/**
 * A page source (D21-15): a path of plain segments under `src/pages/`, an Astro or Markdown page.
 * A layout, a component or a dynamic route renders on many pages, so it is no one page's copy (#686).
 */
function pageSource(path: string): boolean {
  const [top, pages, ...rest] = path.split('/');
  return (
    top === 'src' &&
    pages === 'pages' &&
    rest.every((segment) => SEGMENT.test(segment)) &&
    PAGE_FILE.test(rest.at(-1) ?? '')
  );
}
const WORD_CHARACTER = /[\p{L}\p{M}\p{N}_]/u;

/** Offsets at which `word` stands alone in `text`, not as part of a longer word. */
export function wordOffsets(text: string, word: string): number[] {
  const found: number[] = [];
  if (word === '') return found;
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    // Whole characters, never one code unit: half a surrogate pair is no letter.
    const left = Array.from(text.slice(Math.max(0, at - 2), at)).at(-1) ?? '';
    const next = text.codePointAt(at + word.length);
    const right = next === undefined ? '' : String.fromCodePoint(next);
    if (!WORD_CHARACTER.test(left) && !WORD_CHARACTER.test(right)) found.push(at);
  }
  return found;
}

/** The one standalone occurrence of `word` in `before` whose replacement gives `after`. */
function replacedAt(before: string, after: string, target: CorrectionTarget): number | undefined {
  const matches = wordOffsets(before, target.word).filter(
    (at) =>
      before.slice(0, at) + target.replacement + before.slice(at + target.word.length) === after,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

// Body copy is read as a closed grammar that fails closed: a refused edit costs an approval.

/** What carries JavaScript across a line: a template, a block comment, a line continuation. */
const CARRIES_A_LINE = /`|\/\*|\\$/u;

/** Where body copy starts: past the served page's closing fence, or 0; `undefined` for none. */
function bodyStart(source: string): number | undefined {
  const lines = source.split('\n');
  // The served page's normalisation, line for line: no byte-order mark, no `\r` of a `\r\n`.
  const plain = lines.map((line, index) => {
    const bare = index === 0 ? line.replace(/^﻿/u, '') : line;
    return index < lines.length - 1 && bare.endsWith('\r') ? bare.slice(0, -1) : bare;
  });
  const close = closingFence(plain);
  if (close === undefined) return undefined;
  if (plain.slice(0, close + 1).some((line) => CARRIES_A_LINE.test(line))) return undefined;
  return lines.slice(0, close + 1).reduce((sum, line) => sum + line.length + 1, 0);
}

// An expression: names, numbers, space, these operators and elements; no string, comment or regex.
const EXPRESSION = /[\p{L}\p{N}\s_$.,()[\]?:!=&|+\-*%>]/u;
// A tag's name opens with an ASCII letter, as HTML's does; otherwise its `<` is text there.
const TAG_NAME = /!?[A-Za-z][\p{L}\p{N}_.:-]*/uy;
const ATTRIBUTE = /[\p{L}_@][\p{L}\p{N}_.:-]*/uy;
// Directives that leave children as written; any other (`is:raw`, `set:html`, ...) refuses.
const DIRECTIVE = /^(?:client|class|transition|server):/u;
// Elements whose content is not markup: everything up to their end tag is one construct.
const RAW = new Set(
  'script style textarea title xmp iframe noembed noframes noscript plaintext'.split(' '),
);
const SPACES = /\s*/uy;
const END_TAG_FOLLOWS = /[\t\n\f\r />]/u;
const BLANK_LINE = /\n[\t ]*(?:\n|$)/gu;
// A Markdown word's run holds `.`, `:`, `/` or `@` only as closing punctuation: no autolink.
const MARKDOWN_RUN = /^[\p{L}\p{M}\p{N}'’‘"“”()[\]*_~-]*[.,;:!?)\]"'’”*_~]*$/u;

/** Lower case by ASCII only, as HTML matches an end tag's name. */
const asciiLower = (text: string): string =>
  text.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

function skipSpace(source: string, at: number): number {
  SPACES.lastIndex = at;
  SPACES.test(source);
  return SPACES.lastIndex;
}

/** The end of the expression opening at `at` (`{`), or undefined where it holds anything else. */
function expressionEnd(source: string, at: number): number | undefined {
  let depth = 0;
  for (let next = at; next < source.length; next += 1) {
    const character = source.charAt(next);
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return next + 1;
    } else if (character === '<') {
      const tag = tagEnd(source, next);
      if (tag === undefined || RAW.has(asciiLower(tag.name))) return undefined;
      next = tag.end - 1;
    } else if (!EXPRESSION.test(character)) return undefined;
  }
  return undefined;
}

/** One attribute at `at`: an expression, or a name with a quoted or expression value or none. */
function attributeEnd(source: string, at: number): number | undefined {
  if (source.charAt(at) === '{') return expressionEnd(source, at);
  ATTRIBUTE.lastIndex = at;
  const name = ATTRIBUTE.exec(source)?.[0];
  if (name === undefined || (name.includes(':') && !DIRECTIVE.test(name))) return undefined;
  const equals = skipSpace(source, at + name.length);
  if (source.charAt(equals) !== '=') return equals;
  const value = skipSpace(source, equals + 1);
  const quote = source.charAt(value);
  if (quote === '{') return expressionEnd(source, value);
  if (quote !== '"' && quote !== "'") return undefined;
  const close = source.indexOf(quote, value + 1);
  return close < 0 ? undefined : close + 1;
}

/** A tag opening at `at` (`<`): `<`, `/`?, a name, attributes, `/`?, `>`. Undefined otherwise. */
function tagEnd(source: string, at: number): { end: number; name: string } | undefined {
  let next = source.charAt(at + 1) === '/' ? at + 2 : at + 1;
  TAG_NAME.lastIndex = next;
  const name = TAG_NAME.exec(source)?.[0];
  if (name === undefined) return undefined;
  for (next = skipSpace(source, next + name.length); ; next = skipSpace(source, next)) {
    if (source.charAt(next) === '>') return { end: next + 1, name };
    if (source.startsWith('/>', next)) return { end: next + 2, name };
    const end = attributeEnd(source, next);
    if (end === undefined) return undefined;
    next = end;
  }
}

/** The end of the element opening at `at` when its content is raw text, through its end tag. */
function rawEnd(source: string, start: number, name: string): number | undefined {
  const close = `</${name}`;
  for (let at = source.indexOf('</', start); at >= 0; at = source.indexOf('</', at + 1)) {
    const candidate = asciiLower(source.slice(at, at + close.length));
    if (candidate === close && END_TAG_FOLLOWS.test(source.charAt(at + close.length)))
      return tagEnd(source, at)?.end;
  }
  return undefined;
}

/** The end of a Markdown link's destination opening at `at` (`(` after `]`), on its own line. */
function destinationEnd(source: string, at: number): number | undefined {
  let depth = 0;
  for (let next = at; next < source.length; next += 1) {
    const character = source.charAt(next);
    if (character === '\n') return undefined;
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return next + 1;
    }
  }
  return undefined;
}

/** The blank line ending the paragraph at `at`, or the source's end. */
function paragraphEnd(source: string, at: number): number {
  BLANK_LINE.lastIndex = at;
  return BLANK_LINE.exec(source)?.index ?? source.length;
}

/** The end of the construct at `at`, `at + 1` for text, or undefined where it cannot be read. */
function constructEnd(source: string, at: number, markdown: boolean): number | undefined {
  const character = source.charAt(at);
  if (source.startsWith('<!--', at)) {
    const close = source.indexOf('-->', at + 4);
    return close < 0 ? undefined : close + 3;
  }
  if (character === '<') {
    const tag = tagEnd(source, at);
    if (tag === undefined) return undefined;
    const name = asciiLower(tag.name);
    const raw = source.charAt(at + 1) !== '/' && RAW.has(name);
    return raw ? rawEnd(source, tag.end, name) : tag.end;
  }
  if (character === '{') return expressionEnd(source, at);
  if (character === '}') return undefined;
  if (!markdown) return at + 1;
  if (source.startsWith('](', at)) return destinationEnd(source, at + 1);
  if (source.startsWith(']:', at) || source.startsWith('![', at)) return paragraphEnd(source, at);
  return at + 1;
}

/** The run of non-space characters around `offset`. */
const runAround = (source: string, offset: number): string =>
  (/\S*$/u.exec(source.slice(0, offset))?.[0] ?? '') +
  (/^\S*/u.exec(source.slice(offset))?.[0] ?? '');

/** Whether `offset` is in body copy, read construct by construct from the body's start. */
function inTextNode(source: string, offset: number, markdown: boolean): boolean {
  let at = bodyStart(source);
  if (at === undefined) return false;
  while (at < offset) {
    const end = constructEnd(source, at, markdown);
    if (end === undefined) return false;
    at = end;
  }
  return at === offset && (!markdown || MARKDOWN_RUN.test(runAround(source, offset)));
}

/** Refuses anything wider than the envelope, naming why. */
export function checkEnvelope(change: ProposedChange, target: CorrectionTarget): EnvelopeResult {
  if (!ONE_WORD.test(target.word) || !ONE_WORD.test(target.replacement)) {
    return exceeded('the correction is not one word for one word');
  }
  if (target.word === target.replacement) return exceeded('the word does not change');
  if (change.files.length !== 1) return exceeded('more than one file');
  const [file] = change.files;
  if (file === undefined || file.path !== target.path) return exceeded('not the target file');
  if (!pageSource(file.path)) return exceeded('not a page source');
  if (file.before === null || file.after === null) return exceeded('a create, delete or rename');
  const before = file.before.split('\n');
  const after = file.after.split('\n');
  if (before.length !== after.length) return exceeded('lines added or removed');
  const changed = before.flatMap((line, index) => (line === after[index] ? [] : [index]));
  if (changed.length !== 1)
    return exceeded(changed.length === 0 ? 'no change' : 'more than one line');
  const index = changed[0] ?? 0;
  const at = replacedAt(before[index] ?? '', after[index] ?? '', target);
  if (at === undefined) return exceeded('not the one word replaced in place');
  const offset = before.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0) + at;
  if (!inTextNode(file.before, offset, file.path.endsWith('.md')))
    return exceeded('the word is not in body copy');
  return {
    ok: true,
    value: { path: file.path, line: index + 1, before: target.word, after: target.replacement },
  };
}
