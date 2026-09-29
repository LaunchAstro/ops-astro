// SPDX-License-Identifier: AGPL-3.0-only
//
// C80: one fenced capture of a page is the observation Receipt L's fields 9
// to 12 compare: the visible text, the document's digest, and every served
// stylesheet's digest, each fetched through the fence. A stylesheet that
// cannot be fetched fails the capture rather than dropping out of the
// comparison.

import { describe, expect, it } from 'vitest';
import {
  capturePage,
  type CapturePool,
  type Transport,
  type TransportAnswer,
  type TransportRequest,
} from '../../packages/core-connectors/src/index.ts';

const ABOUT = 'https://www.example.com/about';
const POOL: CapturePool = { agencyPages: [ABOUT], otherPages: [], closedPoolReviews: [] };

const PAGE = `<!doctype html><html><head>
<link rel="stylesheet" href="/_astro/site.css">
<link rel="preload stylesheet" href="https://www.example.com/_astro/extra.css">
<link rel="icon" href="/favicon.svg">
<style>p{margin:0}</style>
<script>var alongside = 1;</script>
</head><body>
<!-- alongside in a comment -->
<p>We walk alongside you &amp; your team.</p>
<noscript>alongside</noscript>
</body></html>`;

function answer(type: string, body: string): TransportAnswer {
  return {
    kind: 'answer',
    status: 200,
    headers: { 'content-type': type },
    body: new TextEncoder().encode(body),
  };
}

function site(pages: Record<string, TransportAnswer>): Transport & { seen: string[] } {
  const seen: string[] = [];
  const missing: TransportAnswer = {
    kind: 'answer',
    status: 404,
    headers: {},
    body: new Uint8Array(),
  };
  const transport = (request: TransportRequest) => {
    seen.push(request.url.href);
    return Promise.resolve(pages[request.url.href] ?? missing);
  };
  return Object.assign(transport, { seen });
}

const publicResolver = () => Promise.resolve(['93.184.215.14']);

describe('C80 one word only (the fenced capture it compares)', () => {
  it('observes the visible text, the document digest and every served stylesheet through the fence', async () => {
    const transport = site({
      [ABOUT]: answer('text/html; charset=utf-8', PAGE),
      'https://www.example.com/_astro/site.css': answer('text/css', 'p{color:#111}'),
      'https://www.example.com/_astro/extra.css': answer('text/css', 'h1{}'),
    });
    const result = await capturePage(ABOUT, { pool: POOL, resolve: publicResolver, transport });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe('We walk alongside you & your team.');
    expect(result.value.documentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.keys(result.value.stylesheets)).toEqual([
      'https://www.example.com/_astro/extra.css',
      'https://www.example.com/_astro/site.css',
      'inline:0',
    ]);
    expect(transport.seen).not.toContain('https://www.example.com/favicon.svg');
  });

  it('changes a stylesheet digest when its served bytes change', async () => {
    const capture = (css: string) =>
      capturePage(ABOUT, {
        pool: POOL,
        resolve: publicResolver,
        transport: site({
          [ABOUT]: answer('text/html', '<link rel="stylesheet" href="/a.css"><p>x</p>'),
          'https://www.example.com/a.css': answer('text/css', css),
        }),
      });
    const [one, two] = await Promise.all([capture('p{}'), capture('p{color:red}')]);
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(one.value.stylesheets['https://www.example.com/a.css']).not.toBe(
      two.value.stylesheets['https://www.example.com/a.css'],
    );
  });
});

describe('C80 one word only (the fenced capture it compares)', () => {
  it.each([
    [
      'another host',
      '<link rel="stylesheet" href="https://cdn.example.net/a.css">',
      'CAPTURE_HOST_NOT_CATALOGUED',
    ],
    [
      'the metadata address',
      '<link rel="stylesheet" href="http://169.254.169.254/a.css">',
      'CAPTURE_HOST_NOT_CATALOGUED',
    ],
    [
      'a missing stylesheet',
      '<link rel="stylesheet" href="/missing.css">',
      'CAPTURE_STATUS_REFUSED',
    ],
    [
      'single quotes and odd case',
      "<LINK REL='StyleSheet' HREF='https://cdn.example.net/a.css'>",
      'CAPTURE_HOST_NOT_CATALOGUED',
    ],
  ])(
    'fails the whole capture on %s, rather than dropping it from the comparison',
    async (_name, link, code) => {
      const result = await capturePage(ABOUT, {
        pool: POOL,
        resolve: publicResolver,
        transport: site({ [ABOUT]: answer('text/html', `${link}<p>x</p>`) }),
      });
      expect(result).toMatchObject({ ok: false, code });
    },
  );

  it('refuses a page outside the catalogue before any request', async () => {
    const transport = site({});
    expect(
      await capturePage('https://www.example.com/contact', {
        pool: POOL,
        resolve: publicResolver,
        transport,
      }),
    ).toMatchObject({ ok: false, code: 'CAPTURE_HOST_NOT_CATALOGUED' });
    expect(transport.seen).toHaveLength(0);
  });
});
