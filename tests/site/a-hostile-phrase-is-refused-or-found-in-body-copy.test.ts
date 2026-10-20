// SPDX-License-Identifier: AGPL-3.0-only
//
// #1987 (spec #1994): hostile cases for the phrase envelope. Spaces and marks
// that look like a space or like nothing, an edge letter outside the basic
// plane, and the phrase where it is not body copy (a title, script, comment
// or style, a Markdown label, image or reference) are each refused, and the
// locate finds the body copy past a commented copy of a heading.

import { describe, expect, it } from 'vitest';
import {
  checkEnvelope,
  replaced,
  wordPairRefusal,
} from '../../packages/core-connectors/src/index.ts';

const ASTRO = 'src/pages/about.astro';
const MARKDOWN = 'src/pages/about.md';
const HEADING = 'We build websites that work';
const REWRITE = 'Websites that earn their keep';

function verdict(path: string, before: string, after: string, word: string, replacement: string) {
  return checkEnvelope({ files: [{ path, before, after }] }, { path, word, replacement });
}

const refused = (reason: string) => ({ ok: false, code: 'CHANGE_ENVELOPE_EXCEEDED', reason });
const NOT_IN_PLACE = refused('not one phrase or sentence on one line replaced in place');

describe('hostile phrases', () => {
  it.each([
    ['a no-break space', 'We build'],
    ['a zero-width space', 'We​build'],
    ['a zero-width joiner', 'We‍build'],
    ['a line separator', 'We build'],
    ['a byte-order mark', '﻿We build'],
  ])('refuses a phrase holding %s', (_name, word) => {
    expect(wordPairRefusal({ word, replacement: 'Websites' })).toBe(
      'the correction is not one phrase or sentence on one line',
    );
  });

  it('reads an edge outside the basic plane as one whole letter', () => {
    const page = '<p>We build \u{1D400}websites that work</p>\n';
    const after = page.replace('websites that work', 'sites that earn');
    expect(verdict(ASTRO, page, after, 'websites that work', 'sites that earn')).toEqual(
      NOT_IN_PLACE,
    );
  });
});

describe('hostile places', () => {
  it.each([
    ['an upper-case title element', '<TITLE>We build websites that work</TITLE>'],
    ['a script', '<script>const t = "We build websites that work";</script>'],
    ['a comment', '<!-- We build websites that work -->'],
    ['a style', '<style>/* We build websites that work */</style>'],
  ])('refuses the phrase inside %s', (_name, line) => {
    const page = `<main>\n${line}\n</main>\n`;
    const after = page.replace(HEADING, REWRITE);
    expect(verdict(ASTRO, page, after, HEADING, REWRITE)).toEqual(
      refused('the word is not in body copy'),
    );
  });

  it.each([
    ['a link label', `[${HEADING}](/about) today.`],
    ['an image description', `![${HEADING}](/hero.png)`],
    ['a reference definition', `[hero]: /about "${HEADING}"`],
  ])('refuses the Markdown phrase inside %s', (_name, line) => {
    const page = `---\ntitle: About\n---\n${line}\n`;
    const after = page.replace(HEADING, REWRITE);
    expect(verdict(MARKDOWN, page, after, HEADING, REWRITE)).toMatchObject({ ok: false });
  });

  it('replaces the heading, not the same words in a comment before it', () => {
    const page = `<main>\n<!-- ${HEADING} -->\n<h1>${HEADING}</h1>\n</main>\n`;
    expect(replaced(ASTRO, page, HEADING, REWRITE)).toBe(
      page.replace(`<h1>${HEADING}`, `<h1>${REWRITE}`),
    );
  });
});
