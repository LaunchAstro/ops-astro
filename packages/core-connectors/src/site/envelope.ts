// SPDX-License-Identifier: AGPL-3.0-only
//
// The change envelope (release decision section 2, D21-2): one file, one
// line, one contiguous word inside one text node, markup and style
// unchanged. It is checked here at proposal time and refused by name, so a
// grown diff never reaches a gate for someone to notice. The captures'
// comparison is `captures.ts`.

import type { Node, TextNode } from '@astrojs/compiler/types';
import { parsedApart } from './page-parse.ts';

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
export function replacedAt(
  before: string,
  after: string,
  target: CorrectionTarget,
): number | undefined {
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

/**
 * Larger sources, or ones with more markup, are refused unparsed and
 * unscanned: the compiler is not trusted with them, and a long line is
 * scanned in quadratic time.
 */
const MOST_BYTES = 64 * 1024;
const MOST_TAG_OPENERS = 2000;

const ELEMENTS: ReadonlySet<string> = new Set([
  'element',
  'component',
  'custom-element',
  'fragment',
]);

/**
 * Whether `node` prints a tag of its own. A fragment, a component or a slot
 * may print nothing, and a script or style may be hoisted out of the page.
 */
function printsTag(node: Node): boolean {
  if (node.type !== 'element' && node.type !== 'custom-element') return false;
  const name = node.name.toLowerCase();
  return name !== 'slot' && !CODE_ELEMENTS.has(name);
}

function tooLarge(source: string): boolean {
  if (source.length > MOST_BYTES) return true;
  let openers = 0;
  for (let at = source.indexOf('<'); at >= 0; at = source.indexOf('<', at + 1)) openers += 1;
  return openers > MOST_TAG_OPENERS || new TextEncoder().encode(source).length > MOST_BYTES;
}

/**
 * The text node holding the bytes from `start` to `end` wholly, in the page
 * as Astro's own compiler reads it, under elements and components only:
 * never the frontmatter, an expression, a comment, a script or style, or an
 * element whose children are raw or replaced. A text node holding '<', or
 * whose recorded position does not hold its own text, is not trusted; nor is
 * a word opening its node (or behind only a '#') where no printed tag comes
 * before it, which can close a tag opener or a character reference left
 * before it.
 */
function textAt(node: Node, bytes: Uint8Array, start: number, end: number): TextNode | undefined {
  if (node.type === 'text') {
    const from = node.position?.start.offset;
    const to = node.position?.end?.offset;
    if (from === undefined || to === undefined || start < from || end > to) return undefined;
    if (node.value.includes('<')) return undefined;
    return new TextDecoder().decode(bytes.subarray(from, to)) === node.value ? node : undefined;
  }
  const tag = ELEMENTS.has(node.type);
  if (!('children' in node) || (!tag && node.type !== 'root')) return undefined;
  if ('name' in node && CODE_ELEMENTS.has(node.name.toLowerCase())) return undefined;
  if ('attributes' in node && node.attributes.some(({ name }) => UNRENDERED.has(name))) {
    return undefined;
  }
  for (const [index, child] of node.children.entries()) {
    const found = textAt(child, bytes, start, end);
    if (found === undefined) continue;
    const lead = bytes.subarray(child.position?.start.offset ?? start, start);
    const opens = found === child && /^#?$/u.test(new TextDecoder().decode(lead));
    return opens && !printsTag(node.children[index - 1] ?? node) ? undefined : found;
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
async function onlyTheWord(
  before: string,
  after: string,
  offset: number,
  target: CorrectionTarget,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(before);
  const start = encoder.encode(before.slice(0, offset)).length;
  const end = start + encoder.encode(target.word).length;
  const read = await parsedApart(before, after);
  if (read === undefined) return false;
  const text = textAt(read.before, bytes, start, end);
  const from = text?.position?.start.offset;
  if (text === undefined || from === undefined) return false;
  const at = new TextDecoder().decode(bytes.subarray(from, start)).length;
  const edited =
    text.value.slice(0, at) + target.replacement + text.value.slice(at + target.word.length);
  const expected = shapeOf(read.before, (node) => (node === text ? edited : node.value));
  const got = shapeOf(read.after, (node) => node.value);
  return JSON.stringify(expected) === JSON.stringify(got);
}

/** Refuses anything wider than the envelope, naming why. */
export async function checkEnvelope(
  change: ProposedChange,
  target: CorrectionTarget,
): Promise<EnvelopeResult> {
  if (!ONE_WORD.test(target.word) || !ONE_WORD.test(target.replacement)) {
    return exceeded('the correction is not one word for one word');
  }
  if (target.word === target.replacement) return exceeded('the word does not change');
  if (change.files.length !== 1) return exceeded('more than one file');
  const [file] = change.files;
  if (file === undefined || file.path !== target.path) return exceeded('not the target file');
  if (!file.path.endsWith('.astro')) return exceeded('not an Astro page');
  if (file.before === null || file.after === null) return exceeded('a create, delete or rename');
  if (tooLarge(file.before) || tooLarge(file.after)) {
    return exceeded('the page is larger than the parser is trusted with');
  }
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
  if (!(await onlyTheWord(file.before, file.after, offset, target))) {
    return exceeded('the word is not in body copy, or the edit changes more than the word');
  }
  return {
    ok: true,
    value: { path: file.path, line: index + 1, before: target.word, after: target.replacement },
  };
}
