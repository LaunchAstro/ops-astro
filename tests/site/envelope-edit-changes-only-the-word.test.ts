// SPDX-License-Identifier: AGPL-3.0-only
//
// The edited page must read, to Astro's compiler, as the same page with only
// that word changed: a swap that turns text into a closing tag changes the
// page's structure and is refused. A page too large to parse safely is
// refused rather than parsed. The decoy is a different page on the same
// site, whatever the spelling of its address. An empty word is no word.

import { describe, expect, it } from 'vitest';
import {
  checkEnvelope,
  compareCaptures,
  type CorrectionTarget,
  type PageObservation,
} from '../../packages/core-connectors/src/index.ts';

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

const target = { path: 'src/pages/about.astro', word: 'alongside', replacement: 'beside' };
const before: PageObservation = {
  url: 'https://www.example.com/about',
  status: 200,
  documentDigest: 'sha256:before',
  text: 'About us. We walk alongside you.',
  stylesheets: {},
};
const after = {
  ...before,
  documentDigest: 'sha256:after',
  text: 'About us. We walk beside you.',
};
const decoyAt = (url: string): PageObservation => ({
  ...before,
  url,
  documentDigest: 'sha256:decoy',
  text: 'We work alongside your team.',
});

describe('the decoy is another page on the same site', () => {
  it.each([
    ['the same page with a trailing slash', 'https://www.example.com/about/'],
    ['the same page with a query', 'https://www.example.com/about?decoy'],
    ['the same page with a fragment', 'https://www.example.com/about#decoy'],
    ['the same page with an upper-case host', 'https://WWW.EXAMPLE.COM/about'],
    ['a page on another site', 'https://elsewhere.example.org/services'],
  ])('fails the decoy when it is %s', (_name, url) => {
    const decoy = decoyAt(url);
    expect(
      compareCaptures({ before, after, decoyBefore: decoy, decoyAfter: { ...decoy }, target }),
    ).toEqual({ ok: false, code: 'NOTHING_ELSE_MOVED_FAILED', fields: ['decoy'] });
  });

  it('holds with a decoy on another path of the same site', () => {
    const decoy = decoyAt('https://www.example.com/services');
    expect(
      compareCaptures({ before, after, decoyBefore: decoy, decoyAfter: { ...decoy }, target }).ok,
    ).toBe(true);
  });

  it('fails, and returns, for an empty word', () => {
    const decoy = decoyAt('https://www.example.com/services');
    const empty = { ...target, word: '' };
    expect(
      compareCaptures({
        before,
        after,
        decoyBefore: decoy,
        decoyAfter: { ...decoy },
        target: empty,
      }).ok,
    ).toBe(false);
  }, 2_000);
});
