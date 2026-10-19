// SPDX-License-Identifier: AGPL-3.0-only
//
// #1987 (spec #1994): a live correction replaces a short phrase or a sentence,
// a page heading for one, on one line of one page file. The phrase stands
// alone at one place on that line, wholly inside body copy, and is replaced in
// place; every other fence of the envelope stays, and each refusal is named.

import { describe, expect, it } from 'vitest';
import {
  checkEnvelope,
  replaced,
  wordPairRefusal,
  type CorrectionTarget,
} from '../../packages/core-connectors/src/index.ts';

const ASTRO = 'src/pages/about.astro';
const MARKDOWN = 'src/pages/about.md';

const ASTRO_PAGE = [
  '---',
  "import Layout from '../layouts/Layout.astro';",
  '---',
  '<Layout title="We build websites that work">',
  '  <title>Our story</title>',
  '  <h1 class="hero">We build websites that work</h1>',
  '  <p>Too many owners navigate growth blind. We chart the course, and walk alongside you.</p>',
  '  <p>Call us. Call us today, or say"Hello there" at the door.</p>',
  '  <p>We build <em>websites</em> that work, {site.name} and all.</p>',
  '</Layout>',
  '',
].join('\n');

const MARKDOWN_PAGE = [
  '---',
  'title: About',
  '---',
  '# We build websites that work',
  '',
  'Too many owners navigate growth blind. We walk alongside you.',
  '',
].join('\n');

/** The page with `from` replaced by `to` on its one line holding `line`. */
function edit(page: string, line: string, from: string, to: string): string {
  return page
    .split('\n')
    .map((each) => (each.includes(line) ? each.replace(from, to) : each))
    .join('\n');
}

function verdict(path: string, before: string, after: string, word: string, replacement: string) {
  const target: CorrectionTarget = { path, word, replacement };
  return checkEnvelope({ files: [{ path, before, after }] }, target);
}

const held = (line: number, before: string, after: string) => ({
  ok: true,
  value: { path: ASTRO, line, before, after },
});
const refused = (reason: string) => ({ ok: false, code: 'CHANGE_ENVELOPE_EXCEEDED', reason });
const NOT_ONE_LINE = refused('the correction is not one phrase or sentence on one line');
const NOT_IN_PLACE = refused('not one phrase or sentence on one line replaced in place');

const HEADING = 'We build websites that work';
const REWRITE = 'Websites that earn their keep';

describe('a phrase on one line of one page is held', () => {
  it('holds a heading rewritten in place on an Astro page', () => {
    const after = edit(ASTRO_PAGE, '<h1', HEADING, REWRITE);
    expect(verdict(ASTRO, ASTRO_PAGE, after, HEADING, REWRITE)).toEqual(held(6, HEADING, REWRITE));
  });

  it('holds a heading rewritten in place on a Markdown page', () => {
    const after = edit(MARKDOWN_PAGE, '# ', HEADING, REWRITE);
    expect(verdict(MARKDOWN, MARKDOWN_PAGE, after, HEADING, REWRITE)).toEqual({
      ok: true,
      value: { path: MARKDOWN, line: 4, before: HEADING, after: REWRITE },
    });
  });

  it('holds one sentence with punctuation becoming another, on both kinds of page', () => {
    const from = 'Too many owners navigate growth blind.';
    const to = 'Too many owners grow without a plan, and it shows!';
    const astro = edit(ASTRO_PAGE, 'Too many', from, to);
    expect(verdict(ASTRO, ASTRO_PAGE, astro, from, to)).toEqual(held(7, from, to));
    const markdown = edit(MARKDOWN_PAGE, 'Too many', from, to);
    expect(verdict(MARKDOWN, MARKDOWN_PAGE, markdown, from, to)).toMatchObject({ ok: true });
  });

  it('refuses the sentence named with other edge punctuation than the line holds', () => {
    const from = 'Too many owners navigate growth blind.';
    const after = edit(ASTRO_PAGE, 'Too many', from, 'Owners grow blind.');
    expect(
      verdict(
        ASTRO,
        ASTRO_PAGE,
        after,
        'Too many owners navigate growth blind!',
        'Owners grow blind.',
      ),
    ).toEqual(NOT_IN_PLACE);
  });

  it('still holds every one-word change of today', () => {
    const after = edit(ASTRO_PAGE, 'Too many', 'alongside', 'beside');
    expect(verdict(ASTRO, ASTRO_PAGE, after, 'alongside', 'beside')).toEqual(
      held(7, 'alongside', 'beside'),
    );
    const markdown = edit(MARKDOWN_PAGE, 'Too many', 'alongside', 'beside');
    expect(verdict(MARKDOWN, MARKDOWN_PAGE, markdown, 'alongside', 'beside')).toMatchObject({
      ok: true,
    });
  });
});

describe('what stays refused, by name', () => {
  it('refuses a phrase standing twice on the line until a distinct one is named', () => {
    const after = edit(ASTRO_PAGE, 'Call us.', 'Call us today', 'Ring us today');
    expect(verdict(ASTRO, ASTRO_PAGE, after, 'Call us', 'Ring us')).toEqual(
      refused('the phrase stands at more than one place on the line'),
    );
    expect(verdict(ASTRO, ASTRO_PAGE, after, 'Call us today', 'Ring us today')).toEqual(
      held(8, 'Call us today', 'Ring us today'),
    );
  });

  it('refuses a phrase across a tag or an expression', () => {
    const tag = edit(ASTRO_PAGE, '<em>', 'We build <em>websites</em>', 'We make sites');
    expect(verdict(ASTRO, ASTRO_PAGE, tag, 'We build <em>websites</em>', 'We make sites')).toEqual(
      NOT_ONE_LINE,
    );
    const expression = edit(ASTRO_PAGE, '<em>', 'work, {site.name} and', 'work and');
    expect(verdict(ASTRO, ASTRO_PAGE, expression, 'work, {site.name} and', 'work and')).toEqual(
      NOT_ONE_LINE,
    );
  });

  it('refuses the document title and an attribute, though they read the same as the heading', () => {
    const title = edit(ASTRO_PAGE, '<title>', 'Our story', 'Who we are');
    expect(verdict(ASTRO, ASTRO_PAGE, title, 'Our story', 'Who we are')).toEqual(
      refused('the word is not in body copy'),
    );
    const attribute = edit(ASTRO_PAGE, '<Layout', HEADING, REWRITE);
    expect(verdict(ASTRO, ASTRO_PAGE, attribute, HEADING, REWRITE)).toEqual(
      refused('the word is not in body copy'),
    );
  });
});

describe('what the text rule refuses, by name', () => {
  it('refuses a phrase holding a line break, a tab, a control or a markup character', () => {
    for (const word of [
      'We build\nwebsites',
      'We build\r\nwebsites',
      'We\tbuild',
      'We\u0000build',
      'We‮build',
      'We  build',
      ' We build',
      'We build ',
      '   ',
      '',
      'a < b',
      'a > b',
      'a { b',
      'a } b',
    ]) {
      expect(wordPairRefusal({ word, replacement: 'Websites' })).toBe(
        'the correction is not one phrase or sentence on one line',
      );
      expect(wordPairRefusal({ word: 'Websites', replacement: word })).toBe(
        'the correction is not one phrase or sentence on one line',
      );
    }
  });

  it('refuses a phrase over 200 characters, and holds one of 200', () => {
    const most = `${'word '.repeat(39)}word.`;
    expect(most).toHaveLength(200);
    expect(wordPairRefusal({ word: most, replacement: 'Short.' })).toBeUndefined();
    expect(wordPairRefusal({ word: `${most}!`, replacement: 'Short.' })).toBe(
      'the phrase is longer than 200 characters',
    );
    expect(wordPairRefusal({ word: 'Short.', replacement: `a${most}` })).toBe(
      'the phrase is longer than 200 characters',
    );
  });

  it('refuses a phrase that does not change', () => {
    expect(wordPairRefusal({ word: HEADING, replacement: HEADING })).toBe(
      'the word does not change',
    );
  });
});

describe('the other fences stay', () => {
  it('refuses two lines, two files and lines added, as for a word', () => {
    const twoLines = edit(
      edit(ASTRO_PAGE, '<h1', HEADING, REWRITE),
      'Too many',
      'alongside',
      'beside',
    );
    expect(verdict(ASTRO, ASTRO_PAGE, twoLines, HEADING, REWRITE)).toEqual(
      refused('more than one line'),
    );
    const added = edit(ASTRO_PAGE, '<h1', HEADING, `${REWRITE}\n`);
    expect(verdict(ASTRO, ASTRO_PAGE, added, HEADING, REWRITE)).toEqual(
      refused('lines added or removed'),
    );
    const target = { path: ASTRO, word: HEADING, replacement: REWRITE };
    const after = edit(ASTRO_PAGE, '<h1', HEADING, REWRITE);
    const file = { path: ASTRO, before: ASTRO_PAGE, after };
    expect(checkEnvelope({ files: [file, { ...file, path: MARKDOWN }] }, target)).toEqual(
      refused('more than one file'),
    );
  });
});

describe('a Markdown phrase changes no markup', () => {
  it.each([
    ['a heading marker', '# Big news'],
    ['a list item', '- We walk'],
    ['an ordered item', '1. We walk'],
    ['emphasis', 'We *walk* with you.'],
    ['a link', 'We walk [with](you) you.'],
    ['code', 'We `walk`'],
    ['a table cell', 'We | walk'],
    ['an autolink', 'We walk www.example.com'],
  ])('refuses a replacement that writes %s', (_markup, to) => {
    const from = 'We walk alongside you.';
    const after = edit(MARKDOWN_PAGE, 'Too many', from, to);
    expect(verdict(MARKDOWN, MARKDOWN_PAGE, after, from, to)).toMatchObject({
      ok: false,
      code: 'CHANGE_ENVELOPE_EXCEEDED',
    });
  });

  it('refuses a phrase that takes the line’s heading marker with it', () => {
    const after = edit(MARKDOWN_PAGE, '# ', `# ${HEADING}`, REWRITE);
    expect(verdict(MARKDOWN, MARKDOWN_PAGE, after, `# ${HEADING}`, REWRITE)).toMatchObject({
      ok: false,
    });
  });
});

describe('the phrase stands alone at both ends', () => {
  it('refuses a phrase whose edge letter runs on into a letter', () => {
    const end = edit(ASTRO_PAGE, 'Too many', 'walk along', 'stroll with');
    expect(verdict(ASTRO, ASTRO_PAGE, end, 'walk along', 'stroll with')).toEqual(NOT_IN_PLACE);
    const start = edit(ASTRO_PAGE, 'Too many', 'alk alongside', 'go beside');
    expect(verdict(ASTRO, ASTRO_PAGE, start, 'alk alongside', 'go beside')).toEqual(NOT_IN_PLACE);
  });

  it('holds a phrase followed by punctuation or a tag', () => {
    const comma = edit(ASTRO_PAGE, 'Too many', 'chart the course', 'set the course');
    expect(verdict(ASTRO, ASTRO_PAGE, comma, 'chart the course', 'set the course')).toEqual(
      held(7, 'chart the course', 'set the course'),
    );
    const tag = edit(ASTRO_PAGE, 'Too many', 'walk alongside you.', 'walk beside you.');
    expect(verdict(ASTRO, ASTRO_PAGE, tag, 'walk alongside you.', 'walk beside you.')).toEqual(
      held(7, 'walk alongside you.', 'walk beside you.'),
    );
  });

  it('needs no boundary beside an edge that is punctuation', () => {
    const quoted = edit(ASTRO_PAGE, 'Call us.', '"Hello there"', '"Good day"');
    expect(verdict(ASTRO, ASTRO_PAGE, quoted, '"Hello there"', '"Good day"')).toEqual(
      held(8, '"Hello there"', '"Good day"'),
    );
  });

  it('refuses a replacement whose edge letter would run on into the line', () => {
    const after = edit(ASTRO_PAGE, 'Call us.', '"Hello there"', 'Hello there');
    expect(verdict(ASTRO, ASTRO_PAGE, after, '"Hello there"', 'Hello there')).toEqual(NOT_IN_PLACE);
  });
});

describe('the locate makes the change the envelope holds', () => {
  it('replaces the heading, not the same words in the layout’s title before it', () => {
    expect(replaced(ASTRO, ASTRO_PAGE, HEADING, REWRITE)).toBe(
      edit(ASTRO_PAGE, '<h1', HEADING, REWRITE),
    );
  });

  it('replaces the first standalone place where none is body copy, for the envelope to refuse', () => {
    expect(replaced(ASTRO, ASTRO_PAGE, 'Our story', 'Who we are')).toBe(
      edit(ASTRO_PAGE, '<title>', 'Our story', 'Who we are'),
    );
    expect(replaced(ASTRO, ASTRO_PAGE, 'walk along', 'go')).toBeNull();
  });
});
