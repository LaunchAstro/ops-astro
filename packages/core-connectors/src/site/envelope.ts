// SPDX-License-Identifier: AGPL-3.0-only
//
// The change envelope (release decision section 2, D21-2): one file, one
// line, one contiguous word inside one text node, markup and style
// unchanged. It is checked here at proposal time and refused by name, so a
// grown diff never reaches a gate for someone to notice. The captures'
// comparison is `captures.ts`.

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
