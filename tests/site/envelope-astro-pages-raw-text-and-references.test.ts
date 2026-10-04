// SPDX-License-Identifier: AGPL-3.0-only
//
// The envelope edits body copy in an Astro page and nothing else: not a
// config, Markdown or headers file. A word whose text a browser may read as
// markup (raw text the compiler and the browser disagree on) is refused, as
// is a word that is part of a character reference. The decoy is not the
// primary page under another spelling of its address.

import { describe, expect, it } from 'vitest';
import {
  checkEnvelope,
  compareCaptures,
  type CorrectionTarget,
  type PageObservation,
} from '../../packages/core-connectors/src/index.ts';

async function edit(path: string, word: string, replacement: string, before: string) {
  const target: CorrectionTarget = { path, word, replacement };
  const after = before.replace(word, replacement);
  return await checkEnvelope({ files: [{ path, before, after }] }, target);
}

describe('the envelope edits Astro pages only', () => {
  it.each([
    ['a config module', 'src/config.ts', 'false', 'true', 'export const live = false;\n'],
    [
      'a Markdown link target',
      'src/content/about.md',
      'good',
      'evil',
      '[Book](https://good.example/)\n',
    ],
    ['a headers file', 'public/_headers', 'good', 'evil', '/*\n  X-Frame-Options: good\n'],
    ['a YAML file', 'src/data/site.yaml', 'yes', 'no', 'indexable: yes\n'],
  ])('refuses %s', async (_name, path, word, replacement, before) => {
    expect(await edit(path, word, replacement, before)).toMatchObject({
      ok: false,
      code: 'CHANGE_ENVELOPE_EXCEEDED',
    });
  });
});

describe('a word a browser may read as markup is refused', () => {
  it.each([
    [
      'in an svg title',
      'good',
      'evil',
      '<svg><title><script>fetch("https://good.example/p")</script></title></svg>\n',
    ],
    [
      'in an svg xmp',
      'good',
      'evil',
      '<svg><xmp><a href="https://good.com">Book</a></xmp></svg>\n',
    ],
    [
      'in a noscript xmp',
      'noscripx',
      'noscript',
      '<noscript><xmp>old </noscripx><img src=x onerror=alert(1)></xmp></noscript>\n',
    ],
    ['in a textarea', 'Hello', 'Hi', '<textarea>Hello there</textarea>\n'],
    ['in a template', 'Hello', 'Hi', '<template><p>Hello there</p></template>\n'],
  ])('refuses a word %s', async (_name, word, replacement, before) => {
    expect(await edit('src/pages/index.astro', word, replacement, before)).toMatchObject({
      ok: false,
    });
  });
});

describe('a word in a character reference is refused', () => {
  it.each([
    ['a named reference', 'amp', 'lt', '<p>Fish &amp; chips</p>\n'],
    ['a legacy reference without its semicolon', 'D', 'copy', '<p>Our R&D team</p>\n'],
  ])('refuses %s', async (_name, word, replacement, before) => {
    expect(await edit('src/pages/index.astro', word, replacement, before)).toMatchObject({
      ok: false,
    });
  });
});

describe('the decoy is not the primary page under another spelling', () => {
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

  it.each([
    'https://www.example.com/%61bout',
    'https://www.example.com/About',
    'https://www.example.com//about',
    'https://www.example.com/about.html',
  ])('fails the decoy at %s when it serves the primary page', (url) => {
    const decoy = { ...before, url };
    expect(
      compareCaptures({ before, after, decoyBefore: decoy, decoyAfter: { ...decoy }, target }),
    ).toEqual({ ok: false, code: 'NOTHING_ELSE_MOVED_FAILED', fields: ['decoy'] });
  });
});
