// SPDX-License-Identifier: AGPL-3.0-only
//
// The text pair of a live correction on its own: a short phrase or a sentence
// for another (#1987), each one line of plain words and punctuation, and where
// it stands alone on a line. The envelope judges it first (`envelope.ts`), and
// a request judges the pair alone before any file is read (#1693), since the
// request carries no file. The wire keeps the names `word` and `replacement`.

/** Runs of anything but whitespace, a control, markup or an expression, single spaces between. */
const ONE_LINE = /^[^\s\p{C}<>{}]+(?: [^\s\p{C}<>{}]+)*$/u;
const MOST_TEXT = 200;

/** Why the pair is not one phrase or sentence for another, or undefined where it is. */
export function wordPairRefusal(pair: {
  readonly word: string;
  readonly replacement: string;
}): string | undefined {
  if (!ONE_LINE.test(pair.word) || !ONE_LINE.test(pair.replacement)) {
    return 'the correction is not one phrase or sentence on one line';
  }
  if (pair.word.length > MOST_TEXT || pair.replacement.length > MOST_TEXT) {
    return 'the phrase is longer than 200 characters';
  }
  if (pair.word === pair.replacement) return 'the word does not change';
  return undefined;
}

const WORD_CHARACTER = /[\p{L}\p{M}\p{N}_]/u;

/** The last whole character of `text` before `at`: half a surrogate pair is no letter. */
const characterBefore = (text: string, at: number): string =>
  Array.from(text.slice(Math.max(0, at - 2), at)).at(-1) ?? '';
const characterAt = (text: string, at: number): string => {
  const next = text.codePointAt(at);
  return next === undefined ? '' : String.fromCodePoint(next);
};

/**
 * Offsets at which `word` stands alone in `text`: where its first or last character is a word
 * character, the character beside it is not one. Punctuation at an edge needs no boundary.
 */
export function wordOffsets(text: string, word: string): number[] {
  const found: number[] = [];
  if (word === '') return found;
  const opens = WORD_CHARACTER.test(characterAt(word, 0));
  const closes = WORD_CHARACTER.test(characterBefore(word, word.length));
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    const left = opens && WORD_CHARACTER.test(characterBefore(text, at));
    const right = closes && WORD_CHARACTER.test(characterAt(text, at + word.length));
    if (!left && !right) found.push(at);
  }
  return found;
}

type Placed = { readonly at: number } | { readonly reason: string };

/**
 * The one place on `before` where `word` stands alone, replaced there to give `after`, with the
 * replacement standing alone there in `after`.
 */
export function placedOnLine(
  before: string,
  after: string,
  target: { readonly word: string; readonly replacement: string },
): Placed {
  const twice = 'the phrase stands at more than one place on the line';
  const inPlace = 'not one phrase or sentence on one line replaced in place';
  const places = wordOffsets(before, target.word);
  const [at] = places;
  if (at === undefined) return { reason: inPlace };
  if (places.length > 1) return { reason: twice };
  if (before.slice(0, at) + target.replacement + before.slice(at + target.word.length) !== after)
    return { reason: inPlace };
  return wordOffsets(after, target.replacement).includes(at) ? { at } : { reason: inPlace };
}
