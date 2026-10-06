// SPDX-License-Identifier: AGPL-3.0-only
//
// The frontmatter fence grammar the served page and the change envelope both read, moved whole
// from `served-page.ts` so the envelope imports no capture code.

// The frontmatter fence, read as a closed grammar over whole lines: a plain fence, a blank line,
// and no other line holding `---` or `+++` anywhere, since a build reads a fence after any prefix
// and closes one after code on its line.
const FENCE = /^[\t ]*---[\t ]*$/u;
const BLANK = /^[\t ]*$/u;
const FENCE_LIKE = /---|\+\+\+/u;

/**
 * The line index of the frontmatter's closing fence by the grammar above, over lines without
 * their byte-order mark or `\r\n` endings: `-1` when the source has no frontmatter, `undefined`
 * when it leaves no page.
 */
export function closingFence(lines: readonly string[]): number | undefined {
  if (lines.some((line) => FENCE_LIKE.test(line) && !FENCE.test(line))) return undefined;
  const fences = lines.flatMap((line, at) => (FENCE.test(line) ? [at] : []));
  if (fences.length === 0) return -1;
  const opens = lines.findIndex((line) => !BLANK.test(line));
  return fences.length === 2 && fences[0] === opens ? fences[1] : undefined;
}
