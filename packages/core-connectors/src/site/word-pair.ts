// SPDX-License-Identifier: AGPL-3.0-only
//
// The word pair of a live correction on its own: one word for one other word.
// The envelope judges it first (`envelope.ts`), and a request judges it alone
// before any file is read (#1693), since the request carries no file.

const ONE_WORD = /^\p{L}+$/u;

/** Why the pair is not one word for one other word, or undefined where it is. */
export function wordPairRefusal(pair: {
  readonly word: string;
  readonly replacement: string;
}): string | undefined {
  if (!ONE_WORD.test(pair.word) || !ONE_WORD.test(pair.replacement)) {
    return 'the correction is not one word for one word';
  }
  if (pair.word === pair.replacement) return 'the word does not change';
  return undefined;
}
