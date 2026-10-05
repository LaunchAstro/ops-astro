// SPDX-License-Identifier: AGPL-3.0-only
//
// The decoy is a different page on the same site, whatever the spelling of
// its address, and never a page serving the primary's document: otherwise an
// untouched decoy proves nothing about the rest of the site. An empty word
// fails the comparison and returns.

import { describe, expect, it } from 'vitest';
import { compareCaptures, type PageObservation } from '../../packages/core-connectors/src/index.ts';

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

describe('the decoy is not the primary page under another spelling', () => {
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

describe('only an https address names a site', () => {
  it.each([
    ['data addresses', 'data:text/html,a', 'data:text/html,b'],
    ['addresses of unknown schemes', 'foo:a', 'bar:b'],
    ['file paths', 'file:///srv/about', 'file:///srv/services'],
  ])('fails the decoy between two %s', (_name, primary, other) => {
    const first = { ...before, url: primary };
    const second = { ...after, url: primary };
    const decoy = { ...decoyAt(other) };
    expect(
      compareCaptures({
        before: first,
        after: second,
        decoyBefore: decoy,
        decoyAfter: { ...decoy },
        target,
      }),
    ).toEqual({ ok: false, code: 'NOTHING_ELSE_MOVED_FAILED', fields: ['decoy'] });
  });
});

describe('the decoy itself is an https page', () => {
  it.each(['blob:https://www.example.com/services', 'blob:https://www.example.com/about'])(
    'fails a decoy at %s',
    (url) => {
      const decoy = decoyAt(url);
      expect(
        compareCaptures({ before, after, decoyBefore: decoy, decoyAfter: { ...decoy }, target }),
      ).toEqual({ ok: false, code: 'NOTHING_ELSE_MOVED_FAILED', fields: ['decoy'] });
    },
  );

  it('reads a path ending in a long run of slashes in linear time', () => {
    const decoy = decoyAt(`https://www.example.com/${'/'.repeat(200_000)}a`);
    const start = performance.now();
    compareCaptures({ before, after, decoyBefore: decoy, decoyAfter: { ...decoy }, target });
    expect(performance.now() - start).toBeLessThan(500);
  });
});
