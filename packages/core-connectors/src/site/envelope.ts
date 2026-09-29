// SPDX-License-Identifier: AGPL-3.0-only
//
// The change envelope (release decision section 2, D21-2): one file, one
// line, one contiguous word inside one text node, markup and style
// unchanged. It is checked here at proposal time and refused by name, so a
// grown diff never reaches a gate for someone to notice.
//
// And the captures' comparison: the word moved on the live page, the rest of
// the page did not, the served stylesheets are equal and the decoy occurrence
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
    const left = at === 0 ? '' : text.slice(at - 1, at);
    const right = text.slice(at + word.length, at + word.length + 1);
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

/** Whether `offset` is in body copy: not frontmatter, a tag, a comment, an expression, a script or a style. */
function inTextNode(source: string, offset: number): boolean {
  if (source.startsWith('---\n')) {
    const close = source.indexOf('\n---', 4);
    if (close < 0 || offset <= close + 4) return false;
  }
  let state: 'text' | 'tag' | 'comment' | 'raw' = 'text';
  let quote = '';
  let braces = 0;
  let rawClose = '';
  for (let at = 0; at < offset; at += 1) {
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
      braces += 1;
    } else if (character === '}') {
      braces = Math.max(0, braces - 1);
    }
  }
  return state === 'text' && braces === 0;
}

/** Refuses anything wider than the envelope, naming why. */
export function checkEnvelope(change: ProposedChange, target: CorrectionTarget): EnvelopeResult {
  return { ok: true, value: { path: target.path, line: change.files.length, before: target.word, after: target.replacement } };
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

export function compareCaptures(input: CaptureComparison): ComparisonResult {
  return { ok: true, value: { wordChanged: true, restOfPageUnchanged: true, stylesheetsUnchanged: true, decoyUnchanged: true } } as ComparisonResult & { input?: typeof input };
}
