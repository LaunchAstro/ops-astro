// SPDX-License-Identifier: AGPL-3.0-only
//
// The edited page must read, to Astro's compiler, as the same page with only
// that word changed: a swap that turns text into a closing tag changes the
// page's structure and is refused. A page too large to parse safely is
// refused rather than parsed. The decoy is a different page on the same
// site, whatever the spelling of its address. An empty word is no word.

import { describe, expect, it } from 'vitest';
import { checkEnvelope, type CorrectionTarget } from '../../packages/core-connectors/src/index.ts';

function proposed(target: CorrectionTarget, before: string, after: string) {
  return { files: [{ path: target.path, before, after }] };
}

describe('the edited page is the same page with one word changed', () => {
  it('refuses a swap that closes a textarea early and turns its text into a live script', async () => {
    const target = { path: 'src/pages/embed.astro', word: 'div', replacement: 'textarea' };
    const before = [
      '<p>Copy this into your site:</p>',
      '<textarea readonly rows="4">',
      '<div id="book-now"></div>',
      '<script src="https://widget.example.com/embed.js"></script>',
      '</textarea>',
      '',
    ].join('\n');
    const after = before.replace('</div>', '</textarea>');
    expect(await checkEnvelope(proposed(target, before, after), target)).toMatchObject({
      ok: false,
      code: 'CHANGE_ENVELOPE_EXCEEDED',
    });
  });

  it('refuses a page larger than the parser is trusted with, and does not throw', async () => {
    const target = { path: 'src/pages/big.astro', word: 'alongside', replacement: 'beside' };
    const before = `<p>We walk alongside you.</p>\n${'<p>filler text</p>\n'.repeat(4_000)}`;
    const after = before.replace('alongside', 'beside');
    expect(await checkEnvelope(proposed(target, before, after), target)).toMatchObject({
      ok: false,
    });
  });
});
