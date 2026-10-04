// SPDX-License-Identifier: AGPL-3.0-only
//
// The page parser is bounded: checks do not grow the host's memory, a page
// with more markup than the parser is trusted with is refused unparsed, and
// a long line is refused before it is scanned. A word that opens its text
// node straight after an expression or comment can join markup or a
// character reference before it, so it is refused.

import { describe, expect, it } from 'vitest';
import {
  checkEnvelope,
  compareCaptures,
  type PageObservation,
} from '../../packages/core-connectors/src/index.ts';
import { parsedApart } from '../../packages/core-connectors/src/site/page-parse.ts';

async function edit(word: string, replacement: string, before: string) {
  const path = 'src/pages/index.astro';
  const after = before.replace(word, replacement);
  return await checkEnvelope({ files: [{ path, before, after }] }, { path, word, replacement });
}

const page = (digest: string, text: string): PageObservation => ({
  url: 'https://www.example.com/about',
  status: 200,
  documentDigest: digest,
  text,
  stylesheets: {},
});

const ordinary = `${'<p>filler</p>\n'.repeat(999)}<p>Hello there</p>\n`;

describe('the parser is bounded', () => {
  it('checks of ordinary pages do not grow the host memory', async () => {
    const start = process.memoryUsage().rss;
    for (let check = 0; check < 25; check += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one check at a time, as a host runs them
      expect(await edit('Hello', 'Hi', ordinary)).toMatchObject({ ok: true });
    }
    expect(process.memoryUsage().rss - start).toBeLessThan(300 * 1024 * 1024);
  }, 60_000);

  it('a page that exhausts the parser ends only its worker, and the host lives on', async () => {
    const huge = `${'<p>x</p>'.repeat(20_000)}\n`;
    expect(await parsedApart(huge, huge)).toBeUndefined();
    await new Promise((settled) => {
      setTimeout(settled, 4000);
    });
    expect(await edit('Hello', 'Hi', ordinary)).toMatchObject({ ok: true });
  }, 30_000);

  it.each([
    ['many elements', `${'<p>x</p>'.repeat(7000)}<p>Hello there</p>\n`],
    ['deep nesting', `${'<b>'.repeat(3000)}Hello there${'</b>'.repeat(3000)}\n`],
  ])(
    'refuses a page of %s unparsed and the host lives on',
    async (_name, before) => {
      await edit('Hello', 'Hi', ordinary);
      expect(await edit('Hello', 'Hi', before)).toMatchObject({ ok: false });
      await new Promise((settled) => {
        setTimeout(settled, 4000);
      });
    },
    30_000,
  );

  it('refuses a long line before it scans it', async () => {
    const before = `<p>${'a '.repeat(500_000)}</p>\n`;
    expect(await edit('a', 'b', before)).toMatchObject({ ok: false });
  }, 3000);

  it('fails a capture whose text is larger than it compares', () => {
    const target = { path: 'src/pages/about.astro', word: 'alongside', replacement: 'beside' };
    const filler = 'x'.repeat(300_000);
    const decoy = {
      ...page('sha256:decoy', 'We work alongside your team.'),
      url: 'https://www.example.com/team',
    };
    expect(
      compareCaptures({
        before: page('sha256:before', `${filler} We walk alongside you.`),
        after: page('sha256:after', `${filler} We walk beside you.`),
        decoyBefore: decoy,
        decoyAfter: { ...decoy },
        target,
      }),
    ).toMatchObject({ ok: false, fields: ['page'] });
  });
});

describe('a word at the edge of its text node', () => {
  it.each([
    [
      'after an empty expression closing a tag opener',
      'Hello',
      'script',
      '<p>a <{""}Hello there</p>\n',
    ],
    ['after an empty expression closing a reference', 'amp', 'lt', '<p>Fish &{""}amp; chips</p>\n'],
    ['after a comment closing a tag opener', 'Hello', 'script', '<p>a <<!---->Hello there</p>\n'],
    ['in text holding a bare less-than', 'Hello', 'Hi', '<p>a < Hello there</p>\n'],
    ['in a numeric reference', 'xABC', 'xABD', '<p>Code &#xABC; here</p>\n'],
  ])('refuses a word %s', async (_name, word, replacement, before) => {
    expect(await edit(word, replacement, before)).toMatchObject({ ok: false });
  });

  it('approves a word straight after an element', async () => {
    expect(await edit('Hello', 'Hi', '<p><b>Note</b>Hello there</p>\n')).toMatchObject({
      ok: true,
    });
  });
});
