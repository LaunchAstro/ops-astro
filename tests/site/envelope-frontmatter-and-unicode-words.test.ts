// SPDX-License-Identifier: AGPL-3.0-only
//
// The body scan starts after the frontmatter, so code there cannot change how
// the page's body copy is read. And a word's neighbours are whole characters:
// a letter outside the Basic Multilingual Plane beside the word makes it part
// of a longer word, never a standalone one.

import { describe, expect, it } from 'vitest';
import { checkEnvelope, type CorrectionTarget } from '../../packages/core-connectors/src/index.ts';

const TARGET: CorrectionTarget = {
  path: 'src/pages/about.astro',
  word: 'alongside',
  replacement: 'beside',
};

function proposed(lines: readonly string[]) {
  const before = lines.join('\n');
  return {
    files: [{ path: TARGET.path, before, after: before.replace('alongside', 'beside') }],
  };
}

/** U+1D400 MATHEMATICAL BOLD CAPITAL A: a letter, two UTF-16 code units. */
const WIDE_LETTER = '\u{1D400}';

describe('the envelope reads frontmatter and Unicode words', () => {
  it('accepts a body word after frontmatter holding an unmatched opening brace', async () => {
    const page = ['---', "const open = '{';", '---', '<p>We walk alongside you.</p>', ''];
    expect(await checkEnvelope(proposed(page), TARGET)).toEqual({
      ok: true,
      value: { path: TARGET.path, line: 4, before: 'alongside', after: 'beside' },
    });
  });

  it.each([
    ['before', `${WIDE_LETTER}alongside`],
    ['after', `alongside${WIDE_LETTER}`],
  ])('a supplementary letter right %s the word joins it to a longer word', async (_side, text) => {
    const page = [`<p>We walk ${text} you.</p>`, ''];
    expect(await checkEnvelope(proposed(page), TARGET)).toMatchObject({
      ok: false,
      code: 'CHANGE_ENVELOPE_EXCEEDED',
    });
  });
});
