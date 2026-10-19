// SPDX-License-Identifier: AGPL-3.0-only
//
// #1987 (spec #1994): the live checks of a phrase. The captures' comparison
// holds a sentence of up to 200 characters, the place is calibrated on the
// served page whose visible text collapses whitespace as the capture reads it,
// the phrase flips there, a phrase that moved elsewhere on the page is
// unconfirmable, and the decoy page is untouched.

import { describe, expect, it } from 'vitest';
import { readDocument } from '../../packages/core-connectors/src/capture/page.ts';
import {
  compareCaptures,
  type CorrectionTarget,
  type PageObservation,
} from '../../packages/core-connectors/src/index.ts';
import { calibrated, flipped } from '../../packages/core-connectors/src/site/reconcile.ts';

const PATH = 'src/pages/index.astro';
// Longer than the 64 characters a word was bounded by, well inside 200.
const SENTENCE =
  'Too many owners are doing great work but navigating growth blind, with no clear course.';
const REWRITE = 'Most owners do great work, and we help them grow it with a clear course.';
const target: CorrectionTarget = { path: PATH, word: SENTENCE, replacement: REWRITE };

function observed(url: string, text: string, digest: string): PageObservation {
  return {
    url,
    status: 200,
    documentDigest: digest,
    text,
    html: `<p>${text}</p>`,
    stylesheets: { 'https://www.example.com/_astro/site.css': 'sha256:css-1' },
  };
}

const HOME = 'https://www.example.com/';
const DECOY = 'https://www.example.com/services';
const before = observed(HOME, `Welcome. ${SENTENCE} Call us.`, 'sha256:home-before');
const after = observed(HOME, `Welcome. ${REWRITE} Call us.`, 'sha256:home-after');
const decoy = observed(DECOY, `Services. ${SENTENCE}`, 'sha256:decoy');

describe('the captures compare a sentence', () => {
  it('holds a sentence that moved, the rest of the page and the decoy page untouched', () => {
    expect(
      compareCaptures({ before, after, decoyBefore: decoy, decoyAfter: decoy, target }),
    ).toMatchObject({ ok: true });
  });

  it('fails the page where the sentence moved and other text moved with it', () => {
    const extra = observed(HOME, `Welcome! ${REWRITE} Call us.`, 'sha256:home-after');
    expect(
      compareCaptures({ before, after: extra, decoyBefore: decoy, decoyAfter: decoy, target }),
    ).toMatchObject({ ok: false, fields: ['page'] });
  });

  it('fails the decoy where the decoy page changed', () => {
    const touched = observed(DECOY, `Services. ${REWRITE}`, 'sha256:decoy-after');
    expect(
      compareCaptures({ before, after, decoyBefore: decoy, decoyAfter: touched, target }),
    ).toMatchObject({ ok: false, fields: ['decoy'] });
  });

  it('does not compare a phrase past 200 characters', () => {
    const long = `${'word '.repeat(40)}end.`;
    const grown = { ...target, word: long };
    const from = observed(HOME, `Welcome. ${long} Call us.`, 'sha256:home-before');
    const decoyed = observed(DECOY, `Services. ${long}`, 'sha256:decoy');
    expect(
      compareCaptures({
        before: from,
        after,
        decoyBefore: decoyed,
        decoyAfter: decoyed,
        target: grown,
      }),
    ).toMatchObject({ ok: false, fields: ['page', 'decoy'] });
  });
});

const HEADING = 'We build websites that work';
const NEW_HEADING = 'Websites that earn their keep';
const heading: CorrectionTarget = { path: PATH, word: HEADING, replacement: NEW_HEADING };

const SOURCE = [
  '---',
  "import Layout from '../layouts/Layout.astro';",
  '---',
  '<Layout title="Home">',
  `  <h1>${HEADING}</h1>`,
  '  <p>We answer the phone.</p>',
  '</Layout>',
  '',
].join('\n');
const change = {
  files: [
    { path: PATH, before: SOURCE, after: SOURCE.replace(`<h1>${HEADING}`, `<h1>${NEW_HEADING}`) },
  ],
};

/** Visible text of served HTML, as the fenced capture reads it. */
function seen(html: string): string {
  const reading = readDocument(html);
  if (typeof reading === 'string') throw new Error(`capture refused: ${reading}`);
  return reading.text;
}

/** The built page: the layout's frame, and the heading laid out over lines as a build may. */
const served = (words: string, rest = 'We answer the phone.') =>
  seen(
    `<!doctype html><html><head><title>Home</title></head><body><main><h1>\n      ${words.replace(' ', '\n      ')}\n    </h1><p>${rest}</p></main></body></html>`,
  );

describe('the live check reads a phrase at its place', () => {
  const place = calibrated(change, heading, served(HEADING));

  it('calibrates on the served page with whitespace collapsed, and reads the flip there', () => {
    expect(place).toMatchObject({ observed: [HEADING] });
    expect(flipped(served(NEW_HEADING), place, HEADING, NEW_HEADING)).toMatchObject({
      observed: [NEW_HEADING],
    });
  });

  it('reads an unchanged page as not live yet', () => {
    expect(flipped(served(HEADING), place, HEADING, NEW_HEADING)).toBeUndefined();
  });

  it('reads the phrase moved elsewhere on the page as unconfirmable', () => {
    const moved = seen(
      `<!doctype html><html><head><title>Home</title></head><body><main><h1>Home</h1><p>We answer the phone. ${NEW_HEADING}</p></main></body></html>`,
    );
    expect(flipped(moved, place, HEADING, NEW_HEADING)).toBe('unconfirmable');
  });
});
