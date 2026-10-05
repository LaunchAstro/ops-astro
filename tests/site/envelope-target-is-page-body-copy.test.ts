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

it('a target path is read as plain segments, and anything else is refused', async () => {
  const copy = '<p>We walk alongside you.</p>\n';
  const paths = {
    'src/pages/blog/launch.astro': true,
    'src/pages/about.md': true,
    'src/pages/blog/[slug].astro': false,
    'src/pages/[...path].astro': false,
    'src/pages/api/contact.ts': false,
    'src/pages/rss.xml.js': false,
    'src/pages/about.mdx': false,
    'src/pages/about.ASTRO': false,
    'src/pages/.about.astro': false,
    'src/pages/./about.astro': false,
    'src/pages//about.astro': false,
    'src/pages/about.astro/': false,
    'src/pages/%2e%2e/layouts/Layout.astro': false,
    'src/pages\\..\\layouts\\Layout.astro': false,
    'src/pages/about\t.astro': false,
    'src/pages/about us.astro': false,
    '/src/pages/about.astro': false,
    './src/pages/about.astro': false,
    'SRC/pages/about.astro': false,
    'src/Pages/about.astro': false,
    'src/pages': false,
    'src/pages/': false,
    'src/pages/‮about.astro': false,
  };
  const held = Object.fromEntries(
    await Promise.all(
      Object.keys(paths).map(async (path) => [
        path,
        await verdict(path, copy, 'alongside', 'beside'),
      ]),
    ),
  );
  expect(held).toEqual(paths);
});
