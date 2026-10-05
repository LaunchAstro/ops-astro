// SPDX-License-Identifier: AGPL-3.0-only
//
// The envelope holds one word of body copy on one page (release decision
// D21-2 and D21-15), so the target is a page source. A layout or component
// renders on every page that uses it, the home page and navigation included
// (catalogue #686).

import { expect, it } from 'vitest';
import { checkEnvelope, type CorrectionTarget } from '../../packages/core-connectors/src/index.ts';

async function verdict(path: string, before: string, word: string, replacement: string) {
  const target: CorrectionTarget = { path, word, replacement };
  const after = before.replace(word, replacement);
  return (await checkEnvelope({ files: [{ path, before, after }] }, target)).ok;
}

it('a one-word change outside the site pages is refused, and a page source is held', async () => {
  const copy = '<footer>\n<p>We walk alongside you.</p>\n</footer>\n';
  const paths = [
    'src/pages/about.astro',
    'src/layouts/Layout.astro',
    'src/components/Footer.astro',
    'src/pages/../layouts/Layout.astro',
  ];
  const held = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, await verdict(path, copy, 'alongside', 'beside')]),
    ),
  );
  expect(held).toEqual({
    'src/pages/about.astro': true,
    'src/layouts/Layout.astro': false,
    'src/components/Footer.astro': false,
    'src/pages/../layouts/Layout.astro': false,
  });
});
