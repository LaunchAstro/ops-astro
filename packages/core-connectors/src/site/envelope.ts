// SPDX-License-Identifier: AGPL-3.0-only
//
// The change envelope (release decision section 2, D21-2): one file, one
// line, one contiguous word inside one text node, markup and style
// unchanged. It is checked here at proposal time and refused by name, so a
// grown diff never reaches a gate for someone to notice. The captures'
// comparison is `captures.ts`.

import { closingFence } from './served-page.ts';

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

// Where a word is body copy, read as a closed grammar that fails closed: the scan admits a word
// only where it can prove it sits in a text node, and anything it cannot read refuses the change.
// A refused valid correction costs a person's approval; an admitted code edit would ship code.

/** What carries JavaScript across a line: a template, a block comment, a line continuation. */
const CARRIES_A_LINE = /`|\/\*|\\$/u;

/**
 * Where body copy can start: just after the frontmatter's closing fence by the served page's fence
 * grammar (`closingFence`), or at zero with no frontmatter. Frontmatter holding anything that can
 * carry its code across a line is refused, so the closing fence cannot sit inside a string or
 * comment. `undefined`: no offset is body copy.
 */
function bodyStart(source: string): number | undefined {
  const lines = source.split('\n');
  // The served page's normalisation, line for line: no byte-order mark, no `\r` of a `\r\n`.
  const plain = lines.map((line, index) => {
    const bare = index === 0 ? line.replace(/^\uFEFF/u, '') : line;
    return index < lines.length - 1 && bare.endsWith('\r') ? bare.slice(0, -1) : bare;
  });
  const close = closingFence(plain);
  if (close === undefined) return undefined;
  if (plain.slice(0, close + 1).some((line) => CARRIES_A_LINE.test(line))) return undefined;
  return lines.slice(0, close + 1).reduce((sum, line) => sum + line.length + 1, 0);
}

// An expression holds only names, numbers, white space, these operators and elements read by the
// tag grammar below: no string, template, comment, regular expression or raw element, whose
// contents the scan would have to read.
const EXPRESSION = /[\p{L}\p{N}\s_$.,()[\]?:!=&|+\-*%>]/u;
const TAG_NAME = /!?\p{L}[\p{L}\p{N}_.:-]*/uy;
const ATTRIBUTE = /[\p{L}_@][\p{L}\p{N}_.:-]*/uy;
// Directives that leave an element's children rendered as written; any other (`is:raw`,
// `set:html`, `define:vars`, ...) changes how they are read, so it refuses.
const DIRECTIVE = /^(?:client|class|transition|server):/u;
// Elements whose content is not markup: everything up to their end tag is one construct.
const RAW = new Set(
  'script style textarea title xmp iframe noembed noframes noscript plaintext'.split(' '),
);
const SPACE = /\s/u;
const END_TAG_FOLLOWS = /[\t\n\f\r />]/u;

/** Lower case by ASCII only, as HTML matches an end tag's name. */
const asciiLower = (text: string): string =>
  text.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

function skipSpace(source: string, at: number): number {
  let next = at;
  while (SPACE.test(source.charAt(next))) next += 1;
  return next;
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

/** A tag opening at `at` (`<`): `<`, `/`?, a name, attributes, `/`?, `>`. Undefined otherwise. */
function tagEnd(source: string, at: number): { end: number; name: string } | undefined {
  let next = source.charAt(at + 1) === '/' ? at + 2 : at + 1;
  TAG_NAME.lastIndex = next;
  const name = TAG_NAME.exec(source)?.[0];
  if (name === undefined) return undefined;
  next += name.length;
  for (;;) {
    next = skipSpace(source, next);
    const character = source.charAt(next);
    if (character === '>') return { end: next + 1, name };
    if (source.startsWith('/>', next)) return { end: next + 2, name };
    if (character === '{') {
      const end = expressionEnd(source, next);
      if (end === undefined) return undefined;
      next = end;
      continue;
    }
    ATTRIBUTE.lastIndex = next;
    const attribute = ATTRIBUTE.exec(source)?.[0];
    if (attribute === undefined) return undefined;
    if (attribute.includes(':') && !DIRECTIVE.test(attribute)) return undefined;
    next = skipSpace(source, next + attribute.length);
    if (source.charAt(next) !== '=') continue;
    next = skipSpace(source, next + 1);
    const quote = source.charAt(next);
    if (quote === '"' || quote === "'") {
      const close = source.indexOf(quote, next + 1);
      if (close < 0) return undefined;
      next = close + 1;
    } else if (quote === '{') {
      const end = expressionEnd(source, next);
      if (end === undefined) return undefined;
      next = end;
    } else return undefined;
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

/**
 * The end of the construct at `at` past text: a comment, a tag (with a raw element's content),
 * an expression, or in Markdown a link's destination or a reference definition. One past `at`
 * for a character of text.
 * Undefined where the scan cannot read the source.
 */
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
  if (markdown && source.startsWith('](', at)) return destinationEnd(source, at + 1);
  // A reference definition's destination and title may run on to later lines: to the blank line.
  if (markdown && source.startsWith(']:', at)) {
    BLANK_LINE.lastIndex = at;
    return BLANK_LINE.exec(source)?.index ?? source.length;
  }
  return at + 1;
}

const BLANK_LINE = /\n[\t ]*(?:\n|$)/gu;
// A Markdown word's run of non-space characters: letters and quotes or brackets around it, then
// closing punctuation. No `.`, `:`, `/` or `@` before the end, so no autolink holds the word.
const MARKDOWN_RUN = /^[\p{L}\p{M}\p{N}'’‘"“”()[\]*_~-]*[.,;:!?)\]"'’”*_~]*$/u;

/** The run of non-space characters around `offset`. */
function runAround(source: string, offset: number): string {
  let start = offset;
  while (start > 0 && !SPACE.test(source.charAt(start - 1))) start -= 1;
  let end = offset;
  while (end < source.length && !SPACE.test(source.charAt(end))) end += 1;
  return source.slice(start, end);
}

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
