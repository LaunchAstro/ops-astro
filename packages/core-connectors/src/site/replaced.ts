// SPDX-License-Identifier: AGPL-3.0-only
//
// The replacement a locate makes of the file it read (#1693): the site runner
// reads the page's file and makes the after-image here, so the file never
// leaves the M5. A phrase can stand in an attribute or the document title
// before the body copy that shows it (#1987), so the place the envelope holds
// is the one replaced.

import { checkEnvelope, wordOffsets } from './envelope.ts';

/**
 * The file at `path` with `word` replaced at its first standalone place the envelope holds,
 * else at its first standalone place, for the envelope to refuse; null where none stands alone.
 * One after-image at a time, and only on a line where the word stands once: the envelope
 * refuses every place on a line where it stands twice.
 */
export function replaced(
  path: string,
  text: string,
  word: string,
  replacement: string,
): string | null {
  const target = { path, word, replacement };
  const offsets = wordOffsets(text, word);
  const afterAt = (at: number) =>
    `${text.slice(0, at)}${replacement}${text.slice(at + word.length)}`;
  // Each place's line, in one pass: the offsets come in order.
  const lineOf: number[] = [];
  let line = 0;
  let next = text.indexOf('\n');
  for (const at of offsets) {
    for (; next !== -1 && next < at; next = text.indexOf('\n', next + 1)) line += 1;
    lineOf.push(line);
  }
  for (const [index, at] of offsets.entries()) {
    const own = lineOf[index];
    // Alone on its line: the places either side of it, in order, are on other lines.
    if (lineOf[index - 1] === own || lineOf[index + 1] === own) continue;
    const after = afterAt(at);
    if (checkEnvelope({ files: [{ path, before: text, after }] }, target).ok) return after;
  }
  const [first] = offsets;
  return first === undefined ? null : afterAt(first);
}
