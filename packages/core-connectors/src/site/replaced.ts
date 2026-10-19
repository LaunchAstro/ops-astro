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
 */
export function replaced(
  path: string,
  text: string,
  word: string,
  replacement: string,
): string | null {
  const target = { path, word, replacement };
  const afters = wordOffsets(text, word).map(
    (at) => `${text.slice(0, at)}${replacement}${text.slice(at + word.length)}`,
  );
  const held = afters.find(
    (after) => checkEnvelope({ files: [{ path, before: text, after }] }, target).ok,
  );
  return held ?? afters[0] ?? null;
}
