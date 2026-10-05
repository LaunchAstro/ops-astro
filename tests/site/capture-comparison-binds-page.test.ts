// SPDX-License-Identifier: AGPL-3.0-only
//
// The captures certify a correction only when each pair is the same page,
// served successfully both times. Matching text and stylesheets from another
// address, or from an error page, prove nothing about the corrected page.

import { describe, expect, it } from 'vitest';
import {
  compareCaptures,
  type CorrectionTarget,
  type PageObservation,
} from '../../packages/core-connectors/src/index.ts';

const TARGET: CorrectionTarget = {
  path: 'src/pages/about.astro',
  word: 'alongside',
  replacement: 'beside',
};

function page(overrides: Partial<PageObservation> = {}): PageObservation {
  return {
    url: 'https://www.example.com/about',
    status: 200,
    documentDigest: 'sha256:doc-before',
    text: 'About us. We walk alongside you from the first call. Our team.',
    stylesheets: { 'https://www.example.com/_astro/site.css': 'sha256:css-1' },
    ...overrides,
  };
}

const before = page();
const after = page({
  documentDigest: 'sha256:doc-after',
  text: 'About us. We walk beside you from the first call. Our team.',
});
const decoy = page({
  url: 'https://www.example.com/services',
  text: 'We work alongside your team.',
  documentDigest: 'sha256:decoy',
});

describe('the capture comparison binds page identity and status', () => {
  it('holds for the passing correction and decoy', () => {
    expect(
      compareCaptures({ before, after, decoyBefore: decoy, decoyAfter: decoy, target: TARGET }).ok,
    ).toBe(true);
  });

  it.each([
    ['the after capture is another address', { url: 'https://www.example.com/about-us' }],
    ['the after capture answered 500', { status: 500 }],
    ['the after capture was a redirect', { status: 301 }],
  ])('fails the page when %s', (_name, overrides) => {
    expect(
      compareCaptures({
        before,
        after: page({ ...after, ...overrides }),
        decoyBefore: decoy,
        decoyAfter: decoy,
        target: TARGET,
      }),
    ).toEqual({ ok: false, code: 'NOTHING_ELSE_MOVED_FAILED', fields: ['page'] });
  });

  it('fails the page when the before capture answered 404', () => {
    expect(
      compareCaptures({
        before: page({ status: 404 }),
        after,
        decoyBefore: decoy,
        decoyAfter: decoy,
        target: TARGET,
      }),
    ).toMatchObject({ ok: false, fields: ['page'] });
  });

  it.each([
    ['the decoy after capture is another address', { url: 'https://www.example.com/team' }],
    ['the decoy after capture answered 500', { status: 500 }],
  ])('fails the decoy when %s', (_name, overrides) => {
    expect(
      compareCaptures({
        before,
        after,
        decoyBefore: decoy,
        decoyAfter: page({ ...decoy, ...overrides }),
        target: TARGET,
      }),
    ).toEqual({ ok: false, code: 'NOTHING_ELSE_MOVED_FAILED', fields: ['decoy'] });
  });
});

describe('the comparison is bounded', () => {
  it('fails a capture whose text is larger than it compares', () => {
    const filler = 'x'.repeat(300_000);
    expect(
      compareCaptures({
        before: page({ text: `${filler} We walk alongside you.` }),
        after: page({ documentDigest: 'sha256:doc-after', text: `${filler} We walk beside you.` }),
        decoyBefore: decoy,
        decoyAfter: { ...decoy },
        target: TARGET,
      }),
    ).toMatchObject({ ok: false, fields: ['page'] });
  });

  it('fails a decoy whose text is larger than it compares', () => {
    const filler = 'x'.repeat(300_000);
    const large = page({ ...decoy, text: `${filler} We work alongside your team.` });
    expect(
      compareCaptures({
        before,
        after,
        decoyBefore: large,
        decoyAfter: { ...large },
        target: TARGET,
      }),
    ).toEqual({ ok: false, code: 'NOTHING_ELSE_MOVED_FAILED', fields: ['decoy'] });
  });
});

describe('the comparison is linear', () => {
  it('compares a page of many one-letter words in linear time', () => {
    // At the text bound, the last of 131,072 'a's replaced: main's filter rebuilt the page per 'a'.
    const many = 'a '.repeat(131_071);
    const start = performance.now();
    const result = compareCaptures({
      before: page({ text: `${many}a` }),
      after: page({ documentDigest: 'sha256:doc-after', text: `${many}b` }),
      decoyBefore: page({ ...decoy, text: 'We work a your team.' }),
      decoyAfter: page({ ...decoy, text: 'We work a your team.' }),
      target: { ...TARGET, word: 'a', replacement: 'b' },
    });
    expect(performance.now() - start).toBeLessThan(150);
    expect(result.ok).toBe(true);
  });
});

describe('the comparison bounds the word', () => {
  it('fails a replacement longer than it compares', () => {
    const replacement = 'b'.repeat(65);
    expect(
      compareCaptures({
        before,
        after: page({
          documentDigest: 'sha256:doc-after',
          text: before.text.replace('alongside', replacement),
        }),
        decoyBefore: decoy,
        decoyAfter: { ...decoy },
        target: { ...TARGET, replacement },
      }),
    ).toEqual({ ok: false, code: 'NOTHING_ELSE_MOVED_FAILED', fields: ['page', 'decoy'] });
  });

  it('fails a word longer than it compares', () => {
    const word = 'a'.repeat(65);
    const long = { ...TARGET, word };
    const pair = (text: string) => ({
      before: page({ text: text.replace('alongside', word) }),
      after: page({
        documentDigest: 'sha256:doc-after',
        text: text.replace('alongside', 'beside'),
      }),
    });
    expect(
      compareCaptures({
        ...pair(before.text),
        decoyBefore: page({ ...decoy, text: `We work ${word} your team.` }),
        decoyAfter: page({ ...decoy, text: `We work ${word} your team.` }),
        target: long,
      }),
    ).toEqual({ ok: false, code: 'NOTHING_ELSE_MOVED_FAILED', fields: ['page', 'decoy'] });
  });
});
