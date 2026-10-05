// SPDX-License-Identifier: AGPL-3.0-only
// The approved occurrence's place holds on the page the build serves, not only on its source:
// the marker stands for a word the page shows, a match spanning blocks or added by a layout
// (its title, its nav) or dropped by the build (frontmatter) cannot move the place onto
// another, and finding and counting it stays linear. Each crossing serves the unchanged page.
import { expect, it } from 'vitest';
import { readDocument } from '../../packages/core-connectors/src/capture/page.ts';
import { occurrenceOf, showsAt } from '../../packages/core-connectors/src/site/reconcile.ts';

const target = { path: 'src/pages/about.astro', word: 'alongside', replacement: 'beside' };

/** Whether the check reads `served` as showing `replacement` at the approved place of `word`. */
function readsLive(
  before: string,
  after: string,
  word: string,
  replacement: string,
  served: string,
) {
  const correction = { path: target.path, word, replacement };
  const where = occurrenceOf({ files: [{ path: target.path, before, after }] }, correction);
  const reading = readDocument(served);
  if (typeof reading === 'string') throw new Error(`Capture refused: ${reading}`);
  return showsAt(reading.text, where, replacement, word);
}

it('a word inside a character reference has no place, so a decoy block never reads live', () => {
  const before = '<p>A &amp; B</p>\n<p>A &amp;lt; B</p>\n';
  const after = '<p>A &lt; B</p>\n<p>A &amp;lt; B</p>\n';
  expect(readsLive(before, after, 'amp', 'lt', before)).toBe(false);
});

it.each([
  [
    'noscript',
    '<noscript>typo</noscript>\n<p>Hello &#xE000; world</p>\n<p>Hello fixed world</p>\n',
  ],
  ['a bogus comment', '<? typo >\n<p>Hello &#57344; world</p>\n<p>Hello fixed world</p>\n'],
])('a hidden word in %s cannot borrow a visible marker character as its place', (_, before) => {
  const after = before.replace('typo', 'fixed');
  expect(readsLive(before, after, 'typo', 'fixed', before)).toBe(false);
});

it('a match spanning a block boundary is counted as the live page counts it', () => {
  const before = '<p>fixed x</p>\n<p>fixed x typo</p>\n';
  const after = '<p>fixed x</p>\n<p>fixed x fixed</p>\n';
  expect(readsLive(before, after, 'typo', 'fixed', before)).toBe(false);
  expect(readsLive(before, after, 'typo', 'fixed', after)).toBe(true);
});

it('a correction in a long paragraph reads live, its place bounded either side', () => {
  const words = Array.from({ length: 400 }, (_, at) => `word${at}`).join(' ');
  const before = `<p>${words} typo ${words}.</p>\n`;
  const after = before.replace('typo', 'fixed');
  const where = occurrenceOf(
    { files: [{ path: target.path, before, after }] },
    { path: target.path, word: 'typo', replacement: 'fixed' },
  );
  expect(
    Math.max(where?.left.length ?? Infinity, where?.right.length ?? Infinity),
  ).toBeLessThanOrEqual(128);
  expect(readsLive(before, after, 'typo', 'fixed', after)).toBe(true);
  expect(readsLive(before, after, 'typo', 'fixed', before)).toBe(false);
});

it('a page of one repeated word is matched in time linear in its length', () => {
  const run = (count: number) => {
    const before = `<p>${'a '.repeat(2 * count)}</p>\n<p>${'a '.repeat(count)}a</p>\n`;
    const after = before.replace(/a<\/p>\n$/u, 'b</p>\n');
    const started = performance.now();
    readsLive(before, after, 'a', 'b', before);
    return performance.now() - started;
  };
  run(2_000);
  expect(run(120_000)).toBeLessThan(5_000);
});

// A built page carries text its source file never shows (a layout's title and nav) and drops
// text the source holds (frontmatter); a match in either cannot move the approved place.
it.each([
  [
    'a title in the layout',
    '---\nimport Layout from \'../layouts/Layout.astro\';\n---\n<Layout title="Contact us">\n<h1>Contcat us</h1>\n<p>Call 07 5555 0100.</p>\n</Layout>\n',
    '<html><head><title>Contact us</title></head><body><h1>Contcat us</h1><p>Call 07 5555 0100.</p></body></html>',
  ],
  [
    'a nav link in the layout',
    "---\nimport Layout from '../layouts/Layout.astro';\n---\n<Layout>\n<h1>Contcat</h1>\n<p>Call us.</p>\n</Layout>\n",
    '<nav><a href="/">Home</a><a href="/contact">Contact</a></nav><h1>Contcat</h1><p>Call us.</p>',
  ],
  [
    'frontmatter the build never serves',
    "---\nconst heading = 'Contact';\n---\n<h1>Contcat</h1>\n<p>Contact</p>\n",
    '<h1>Contcat</h1>\n<p>Contact</p>',
  ],
  [
    'frontmatter dropped and a footer added',
    "---\nconst old = 'Contcat';\n---\n<h1>Contcat</h1>\n",
    '<h1>Contcat</h1><footer>Contact</footer>',
  ],
])('%s cannot make the unchanged page read live', (_, before, served) => {
  const after = before.replace('<h1>Contcat', '<h1>Contact');
  expect(readsLive(before, after, 'Contcat', 'Contact', served)).toBe(false);
});

it('finding the changed word in one long line is linear in its length', () => {
  const run = (count: number) => {
    const before = `<p>${'a '.repeat(count)}a</p>\n`;
    const started = performance.now();
    occurrenceOf(
      { files: [{ path: target.path, before, after: before.replace(/a<\/p>/u, 'b</p>') }] },
      { path: target.path, word: 'a', replacement: 'b' },
    );
    return performance.now() - started;
  };
  run(1_000);
  expect(run(400_000)).toBeLessThan(5_000);
});

// Astro reads each of these as frontmatter, so none of its text is on the built page.
const fenced = {
  'a byte-order mark': "\uFEFF---\nconst old = 'Contcat';\n---\n",
  'leading blank lines': "\n\n---\nconst old = 'Contcat';\n---\n",
  'leading spaces': "  ---\nconst old = 'Contcat';\n---\n",
  'trailing spaces on the fences': "--- \nconst old = 'Contcat';\n---  \n",
  'carriage returns': "---\r\nconst old = 'Contcat';\r\n---\r\n",
};

it.each(Object.entries(fenced))(
  'frontmatter after %s is never read as page text',
  (_, frontmatter) => {
    const before = `${frontmatter}<h1>Contcat</h1>\n`;
    const after = before.replace('<h1>Contcat', '<h1>Contact');
    expect(
      readsLive(before, after, 'Contcat', 'Contact', '<h1>Contcat</h1><footer>Contact</footer>'),
    ).toBe(false);
    expect(readsLive(before, after, 'Contcat', 'Contact', '<h1>Contact</h1>')).toBe(true);
  },
);

it.each([
  ['inside a template literal', "---\nconst note = `\n---\n`;\nconst old = 'Contcat';\n---\n"],
  ['inside a block comment', "---\n/*\n---\n*/\nconst old = 'Contcat';\n---\n"],
  ['with code before it', "const x = 1;\n---\nconst old = 'Contcat';\n---\n"],
])('a fence line %s leaves the page with no place', (_, frontmatter) => {
  const before = `${frontmatter}<h1>Contcat</h1>\n`;
  const after = before.replace('<h1>Contcat', '<h1>Contact');
  const where = occurrenceOf(
    { files: [{ path: target.path, before, after }] },
    { path: target.path, word: 'Contcat', replacement: 'Contact' },
  );
  expect(where).toBeUndefined();
});

it.each([
  ['past its words', { left: '', right: '', index: 3, words: ['Contcat'] }],
  ['before them', { left: '', right: '', index: -1, words: ['Contcat'] }],
  ['with no words', { left: '', right: '', index: 0, words: [] }],
])('a place whose rank is %s never reads live', (_, where) => {
  expect(showsAt('Contact', where, 'Contact', 'Contcat')).toBe(false);
});

// A build reads each of these as a fence too (or as frontmatter of another kind), so any line
// that could open or close frontmatter without being a plain `---` leaves the page with no place.
it.each([
  ['a no-break space', "---\nconst old = 'Contcat';\n\u00A0---\n"],
  ['a form feed', "\f---\nconst old = 'Contcat';\n\f---\n"],
  ['a zero-width space', "\u200B---\nconst old = 'Contcat';\n\u200B---\n"],
  ['a comment after the fence', "--- // start\nconst old = 'Contcat';\n--- // end\n"],
  ['carriage returns alone', "---\rconst old = 'Contcat';\r---\r"],
  [
    'one odd closer after a fence in code',
    "---\nconst md = `\n---\n`;\nconst old = 'Contcat';\n--- // end\n",
  ],
  ['TOML fences', '+++\ntitle = "Contcat"\n+++\n\n'],
  ['a next-line control', "\u0085---\nconst old = 'Contcat';\n\u0085---\n"],
  ['a letter before it', "x---\nconst old = 'Contcat';\nx---\n"],
  ['the closer after code', "\u0085---\nconst old = 'Contcat';\nconst year = 2026; ---\n"],
  ['a decrement in the code', "---\nlet i = 2;\ni---1;\nconst old = 'Contcat';\n---\n"],
])('a fence written with %s leaves the page with no place', (_, frontmatter) => {
  const before = `${frontmatter}<h1>Contcat</h1>\n`;
  const after = before.replace('<h1>Contcat', '<h1>Contact');
  expect(
    readsLive(before, after, 'Contcat', 'Contact', '<h1>Contcat</h1><footer>Contact</footer>'),
  ).toBe(false);
  const where = occurrenceOf(
    { files: [{ path: target.path, before, after }] },
    { path: target.path, word: 'Contcat', replacement: 'Contact' },
  );
  expect(where).toBeUndefined();
});

it('a long run of spaces in another line is read in linear time', () => {
  const run = (count: number) => {
    const before = `<h1>Contcat</h1>\n<p>${' '.repeat(count)}x</p>\n`;
    const started = performance.now();
    occurrenceOf(
      { files: [{ path: target.path, before, after: before.replace('Contcat', 'Contact') }] },
      { path: target.path, word: 'Contcat', replacement: 'Contact' },
    );
    return performance.now() - started;
  };
  run(1_000);
  expect(run(160_000)).toBeLessThan(5_000);
});

it('a place read back without its words never reads live', () => {
  const stored: unknown = JSON.parse('{"left":"","right":"","index":0}');
  expect(showsAt('Home Contact Contcat Call us.', stored as never, 'Contact', 'Contcat')).toBe(
    false,
  );
});

it('a marker character after the word in its own block leaves it with no place', () => {
  const before = '<p>We walk alongside you \uE000.</p>\n';
  const after = before.replace('alongside', 'beside');
  expect(occurrenceOf({ files: [{ path: target.path, before, after }] }, target)).toBeUndefined();
});

it('a reference name as the word cannot borrow a layout that shows references as text', () => {
  const before = '<p>A &amp; B</p>\n<p>A &amp;amp; B</p>\n';
  const after = before.replace('<p>A &amp; B', '<p>A &lt; B');
  const served = '<header>A &amp;lt; B</header><p>A &amp; B</p><p>A &amp;amp; B</p>';
  expect(readsLive(before, after, 'amp', 'lt', served)).toBe(false);
});
