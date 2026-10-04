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
// elsewhere on the site is untouched (Receipt L fields 9 to 12).

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
 * The offset just past the quote that closes the string opening at `open`. A
 * template literal's `${}` is read as an expression, so its braces and quotes
 * count only there.
 */
function quotedEnd(source: string, open: number): number {
  const quote = source.charAt(open);
  for (let at = open + 1; at < source.length; at += 1) {
    const character = source.charAt(at);
    if (character === '\\') at += 1;
    else if (character === quote) return at + 1;
    else if (quote === '`' && source.startsWith('${', at)) at = expressionEnd(source, at + 1) - 1;
    else if (quote !== '`' && character === '\n') return at + 1;
  }
  return source.length;
}

/**
 * The offset just past the `}` that closes the expression opening at `open`,
 * read as JavaScript: a brace or quote inside a string, a template literal or
 * a comment counts for nothing. The source's length when it never closes.
 */
function expressionEnd(source: string, open: number): number {
  let depth = 0;
  let at = open;
  while (at < source.length) {
    const character = source.charAt(at);
    if (source.startsWith('//', at)) {
      const end = source.indexOf('\n', at);
      at = end < 0 ? source.length : end;
    } else if (source.startsWith('/*', at)) {
      const end = source.indexOf('*/', at + 2);
      at = end < 0 ? source.length : end + 2;
    } else if (character === '"' || character === "'" || character === '`') {
      at = quotedEnd(source, at);
    } else {
      if (character === '{') depth += 1;
      if (character === '}') depth -= 1;
      at += 1;
      if (depth === 0) return at;
    }
  }
  return source.length;
}

/**
 * Whether `offset` is in body copy: not frontmatter, a tag, a comment, an
 * expression, a script or a style. The scan starts past the frontmatter, so
 * nothing in its code carries over into the body.
 */
function inTextNode(source: string, offset: number): boolean {
  let start = 0;
  if (source.startsWith('---\n')) {
    const close = source.indexOf('\n---', 4);
    if (close < 0 || offset <= close + 4) return false;
    start = close + 4;
  }
  let state: 'text' | 'tag' | 'comment' | 'raw' = 'text';
  let quote = '';
  let rawClose = '';
  for (let at = start; at < offset; at += 1) {
    const rest = source.slice(at);
    const character = source.charAt(at);
    if (state === 'comment') {
      if (rest.startsWith('-->')) {
        state = 'text';
        at += 2;
      }
    } else if (state === 'raw') {
      if (rest.toLowerCase().startsWith(rawClose)) {
        state = 'tag';
        rawClose = '';
      }
    } else if (state === 'tag') {
      if (quote !== '') {
        if (character === quote) quote = '';
      } else if (character === '{') {
        const end = expressionEnd(source, at);
        if (end > offset) return false;
        at = end - 1;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        state = rawClose === '' ? 'text' : 'raw';
      }
    } else if (rest.startsWith('<!--')) {
      state = 'comment';
    } else if (/^<\/?[a-z!]/iu.test(rest)) {
      state = 'tag';
      const raw = /^<(script|style)\b/iu.exec(rest);
      rawClose = raw === null ? '' : `</${raw[1]?.toLowerCase() ?? ''}`;
      if (rest.startsWith('</')) rawClose = '';
    } else if (character === '{') {
      const end = expressionEnd(source, at);
      if (end > offset) return false;
      at = end - 1;
    }
  }
  return state === 'text';
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
  if (!inTextNode(file.before, offset)) return exceeded('the word is not in body copy');
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
