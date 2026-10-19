// SPDX-License-Identifier: AGPL-3.0-only
//
// The one-word replacement a locate makes of the file it read (#1693): the
// site runner reads the page's file and makes the after-image here, so the
// file never leaves the M5. Moved unchanged from the web, which no longer
// sees the file.

const isLetter = (char: string | undefined): boolean =>
  char !== undefined && /^[\p{L}\p{N}'’-]$/u.test(char);

/** The text with the first whole `word` replaced, or null where it is not there. */
export function replaced(text: string, word: string, replacement: string): string | null {
  let at = word === '' ? -1 : text.indexOf(word);
  while (at !== -1) {
    if (!isLetter(text[at - 1]) && !isLetter(text[at + word.length])) {
      return `${text.slice(0, at)}${replacement}${text.slice(at + word.length)}`;
    }
    at = text.indexOf(word, at + 1);
  }
  return null;
}
