// SPDX-License-Identifier: AGPL-3.0-only
//
// The change envelope (release decision section 2, D21-2): one file, one
// line, one contiguous word inside one text node, markup and style
// unchanged. It is checked here at proposal time and refused by name, so a
// grown diff never reaches a gate for someone to notice.
//
// And the captures' comparison: each pair is one address served
// successfully both times, the word moved on the live page, the rest of the
// page did not, the served stylesheets are equal and the decoy occurrence
// elsewhere on the site, on another page, is untouched (Receipt L fields 9
// to 12).

import { parse } from '@astrojs/compiler/sync';
import type { Node, TextNode } from '@astrojs/compiler/types';

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

/**
 * Elements whose children are code or raw text, never body copy: the
 * compiler and a browser can disagree on where raw text ends.
 */
const CODE_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'title',
  'textarea',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'plaintext',
  'template',
]);
/** Directives under which an element's children are not rendered as written. */
const UNRENDERED: ReadonlySet<string> = new Set(['is:raw', 'set:html', 'set:text']);

/** Larger sources are refused unparsed: the compiler is not trusted with them. */
const MOST_BYTES = 64 * 1024;

/**
 * The text node holding the bytes from `start` to `end` wholly, in the page
 * as Astro's own compiler reads it, under elements and components only:
 * never the frontmatter, an expression, a comment, a script or style, or an
 * element whose children are raw or replaced. A text node holding '<', or
 * whose recorded position does not hold its own text, is not trusted.
 */
function textAt(node: Node, bytes: Uint8Array, start: number, end: number): TextNode | undefined {
  if (node.type === 'text') {
    const from = node.position?.start.offset;
    const to = node.position?.end?.offset;
    if (from === undefined || to === undefined || start < from || end > to) return undefined;
    if (node.value.includes('<')) return undefined;
    return new TextDecoder().decode(bytes.subarray(from, to)) === node.value ? node : undefined;
  }
  const tag =
    node.type === 'element' ||
    node.type === 'component' ||
    node.type === 'custom-element' ||
    node.type === 'fragment';
  if (tag && CODE_ELEMENTS.has(node.name.toLowerCase())) return undefined;
  if (tag && node.attributes.some((attribute) => UNRENDERED.has(attribute.name))) return undefined;
  if (!tag && node.type !== 'root') return undefined;
  for (const child of node.children) {
    const found = textAt(child, bytes, start, end);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** What a page is made of, positions aside, with `edit` giving each text node's value. */
function shapeOf(node: Node, edit: (text: TextNode) => string): unknown {
  return {
    type: node.type,
    name: 'name' in node ? node.name : undefined,
    attributes:
      'attributes' in node
        ? node.attributes.map(({ name, kind, value }) => [name, kind, value])
        : [],
    value: node.type === 'text' ? edit(node) : 'value' in node ? node.value : undefined,
    children: 'children' in node ? node.children.map((child) => shapeOf(child, edit)) : [],
  };
}

/**
 * Whether the word at `offset` is body copy the built page shows, and the
 * edited page reads to the compiler as the same page with only that word
 * changed: a swap that turns text into markup changes the page's shape.
 */
function onlyTheWord(before: string, after: string, offset: number, target: CorrectionTarget) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(before);
  if (bytes.length > MOST_BYTES || encoder.encode(after).length > MOST_BYTES) return false;
  const start = encoder.encode(before.slice(0, offset)).length;
  const end = start + encoder.encode(target.word).length;
  try {
    const read = parse(before, { position: true }).ast;
    const text = textAt(read, bytes, start, end);
    const from = text?.position?.start.offset;
    if (text === undefined || from === undefined) return false;
    const at = new TextDecoder().decode(bytes.subarray(from, start)).length;
    const edited =
      text.value.slice(0, at) + target.replacement + text.value.slice(at + target.word.length);
    const expected = shapeOf(read, (node) => (node === text ? edited : node.value));
    const got = shapeOf(parse(after, { position: false }).ast, (node) => node.value);
    return JSON.stringify(expected) === JSON.stringify(got);
  } catch {
    return false;
  }
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
  if (!file.path.endsWith('.astro')) return exceeded('not an Astro page');
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
  if (/&#?$/u.test((before[index] ?? '').slice(0, at))) {
    return exceeded('the word is part of a character reference');
  }
  const offset = before.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0) + at;
  if (!onlyTheWord(file.before, file.after, offset, target)) {
    return exceeded('the word is not in body copy, or the edit changes more than the word');
  }
  return {
    ok: true,
    value: { path: file.path, line: index + 1, before: target.word, after: target.replacement },
  };
}

/** What one fenced capture of a page observed. */
export interface PageObservation {
  readonly url: string;
  readonly status: number;
  readonly documentDigest: string;
  /** The page's visible text, whitespace collapsed. */
  readonly text: string;
  /** Every stylesheet the page loads, by address, with its digest. */
  readonly stylesheets: Readonly<Record<string, string>>;
}

export interface CaptureComparison {
  readonly before: PageObservation;
  readonly after: PageObservation;
  readonly decoyBefore: PageObservation;
  readonly decoyAfter: PageObservation;
  readonly target: CorrectionTarget;
}

export interface NothingElseMoved {
  readonly wordChanged: true;
  readonly restOfPageUnchanged: true;
  readonly stylesheetsUnchanged: true;
  readonly decoyUnchanged: true;
}

export type ComparisonResult =
  | { readonly ok: true; readonly value: NothingElseMoved }
  | {
      readonly ok: false;
      readonly code: 'NOTHING_ELSE_MOVED_FAILED';
      readonly fields: readonly ('word' | 'page' | 'stylesheets' | 'decoy')[];
    };

function sameStylesheets(left: PageObservation, right: PageObservation): boolean {
  const keys = Object.keys(left.stylesheets).toSorted();
  const other = Object.keys(right.stylesheets).toSorted();
  return (
    keys.length === other.length &&
    keys.every(
      (key, index) => key === other[index] && left.stylesheets[key] === right.stylesheets[key],
    )
  );
}

const served = (page: PageObservation): boolean => page.status >= 200 && page.status < 300;

/** A page's path, a trailing slash aside. */
const pagePath = (url: URL): string => url.pathname.replace(/\/+$/u, '');

/** `decoy` is on `primary`'s site, at another path, however either is spelled. */
function anotherPageOfSite(decoy: string, primary: string): boolean {
  const left = URL.parse(decoy);
  const right = URL.parse(primary);
  if (left === null || right === null) return false;
  return left.origin === right.origin && pagePath(left) !== pagePath(right);
}

/** Both captures are of one address, and each was served successfully. */
function samePage(left: PageObservation, right: PageObservation): boolean {
  return left.url === right.url && served(left) && served(right);
}

export function compareCaptures(input: CaptureComparison): ComparisonResult {
  const { before, after, decoyBefore, decoyAfter, target } = input;
  const failed: ('word' | 'page' | 'stylesheets' | 'decoy')[] = [];
  if (after.text === before.text) failed.push('word');
  const moved =
    after.text !== before.text && replacedAt(before.text, after.text, target) === undefined;
  if (moved || !samePage(before, after)) failed.push('page');
  if (!sameStylesheets(before, after)) failed.push('stylesheets');
  const decoyHeld =
    anotherPageOfSite(decoyBefore.url, before.url) &&
    ![before.documentDigest, after.documentDigest].includes(decoyBefore.documentDigest) &&
    samePage(decoyBefore, decoyAfter) &&
    wordOffsets(decoyBefore.text, target.word).length > 0 &&
    decoyAfter.text === decoyBefore.text &&
    decoyAfter.documentDigest === decoyBefore.documentDigest &&
    sameStylesheets(decoyBefore, decoyAfter);
  if (!decoyHeld) failed.push('decoy');
  if (failed.length > 0) return { ok: false, code: 'NOTHING_ELSE_MOVED_FAILED', fields: failed };
  return {
    ok: true,
    value: {
      wordChanged: true,
      restOfPageUnchanged: true,
      stylesheetsUnchanged: true,
      decoyUnchanged: true,
    },
  };
}
