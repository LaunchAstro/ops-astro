// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 hostile provider, the capture path: the fenced capture (C18-1) meeting
// a hostile answer. Catalogued pages only, its own pool, no
// provider credential, no private network, the hard denies checked on the
// resolved address at every redirect, and every connection pinned to the
// address that was checked.

import { describe, expect, it } from 'vitest';
import {
  capturePage,
  fencedFetch,
  type CapturePool,
  type FenceRefusal,
  type Resolver,
  type Transport,
  type TransportRequest,
} from '../../packages/core-connectors/src/index.ts';

const ABOUT = 'https://www.example.com/about';
const SERVICES = 'https://www.example.com/services';
const PUBLIC_V4 = '93.184.215.14';
const OTHER_PUBLIC_V4 = '93.184.215.15';
const HTML = 'text/html; charset=utf-8';

const POOL: CapturePool = {
  agencyPages: [ABOUT, SERVICES],
  otherPages: ['https://client.example.org/'],
  closedPoolReviews: [],
};

function resolverOf(...answers: string[][]): Resolver & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const resolve = (host: string) => {
    calls.push(host);
    const answer = answers[Math.min(index, answers.length - 1)] ?? [];
    index += 1;
    return Promise.resolve(answer);
  };
  return Object.assign(resolve, { calls });
}

type Script = (request: TransportRequest) => Awaited<ReturnType<Transport>>;

function transportOf(script: Script): Transport & { seen: TransportRequest[] } {
  const seen: TransportRequest[] = [];
  const transport = (request: TransportRequest) => {
    seen.push(request);
    return Promise.resolve(script(request));
  };
  return Object.assign(transport, { seen });
}

const answering = (type: string, body: string | Uint8Array, status = 200) =>
  ({
    kind: 'answer',
    status,
    headers: { 'content-type': type },
    body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
  }) as const;

const options = (transport: Transport) => ({
  pool: POOL,
  resolve: resolverOf([PUBLIC_V4], [OTHER_PUBLIC_V4]),
  transport,
  kind: 'document' as const,
});

describe('C80 hostile provider (capture path)', () => {
  it('refuses and records a redirect to an unlisted destination', async () => {
    const recorded: FenceRefusal[] = [];
    const transport = transportOf(() => ({
      kind: 'answer',
      status: 302,
      headers: { location: 'https://evil.example.net/steal' },
      body: new Uint8Array(),
    }));
    const result = await fencedFetch(ABOUT, {
      ...options(transport),
      record: (refusal) => recorded.push(refusal),
    });
    expect(result).toMatchObject({ ok: false, code: 'CAPTURE_HOST_NOT_CATALOGUED' });
    expect(recorded).toHaveLength(1);
    expect(transport.seen).toHaveLength(1);
  });

  it('refuses a redirect loop past three hops', async () => {
    const transport = transportOf((request) => ({
      kind: 'answer',
      status: 301,
      headers: { location: request.url.pathname === '/about' ? SERVICES : ABOUT },
      body: new Uint8Array(),
    }));
    expect(await fencedFetch(ABOUT, options(transport))).toMatchObject({
      ok: false,
      code: 'CAPTURE_TOO_MANY_REDIRECTS',
    });
    expect(transport.seen.length).toBeLessThanOrEqual(4);
  });
});

describe('C80 hostile provider (capture path)', () => {
  it.each([
    [{ kind: 'timeout' } as const, 'CAPTURE_TIMEOUT'],
    [{ kind: 'oversized' } as const, 'CAPTURE_OVERSIZED'],
    [{ kind: 'failed' } as const, 'CAPTURE_FAILED'],
    [answering('application/json', '{'), 'CAPTURE_BODY_MALFORMED'],
    [answering(HTML, new Uint8Array([0xff, 0xfe, 0xfd])), 'CAPTURE_BODY_MALFORMED'],
    [answering(HTML, '', 500), 'CAPTURE_STATUS_REFUSED'],
    [
      { kind: 'answer', status: 301, headers: {}, body: new Uint8Array() } as const,
      'CAPTURE_BODY_MALFORMED',
    ],
  ])('refuses and records %o as %s', async (answer, code) => {
    const recorded: FenceRefusal[] = [];
    const result = await fencedFetch(ABOUT, {
      ...options(transportOf(() => answer)),
      record: (refusal) => recorded.push(refusal),
    });
    expect(result).toMatchObject({ ok: false, code });
    expect(recorded.map((entry) => entry.code)).toEqual([code]);
  });
});

const sheets = (count: number) =>
  Array.from({ length: count }, (_, at) => `<link rel=stylesheet href="/s.css?n=${at}">`);

describe('C80 hostile provider (capture path), stylesheet fan-out', () => {
  // Security review of P25, low 2: every linked sheet was fetched at once, with no cap.
  const page = (links: readonly string[]) =>
    transportOf((request) => ({
      kind: 'answer',
      status: 200,
      headers: { 'content-type': request.url.pathname === '/about' ? HTML : 'text/css' },
      body: new TextEncoder().encode(request.url.pathname === '/about' ? links.join('') : 'p{}'),
    }));
  const capture = (transport: Transport) =>
    capturePage(ABOUT, { pool: POOL, resolve: resolverOf([PUBLIC_V4]), transport });

  it('refuses a page linking 33 distinct sheets as oversized, fetching none of them', async () => {
    const transport = page(sheets(33));
    expect(await capture(transport)).toEqual({ ok: false, code: 'CAPTURE_OVERSIZED' });
    expect(transport.seen.map((seen) => seen.url.pathname)).toEqual(['/about']);
  });

  it('fetches 32 sheets a few at a time, and counts one sheet linked twice once', async () => {
    let open = 0;
    let widest = 0;
    const served = page([...sheets(32), ...sheets(32)]);
    const transport: Transport = async (request) => {
      open += 1;
      widest = Math.max(widest, open);
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
      open -= 1;
      return served(request);
    };
    expect((await capture(transport)).ok).toBe(true);
    expect(served.seen).toHaveLength(33);
    expect(widest).toBeLessThanOrEqual(4);
  });
});

// Security review of P25, third re-bind, finding 3: an imported sheet was never fetched, so it
// could change while every digest the capture held stayed equal.
const served = (css: (path: string) => string, html: string) =>
  transportOf((request) => {
    const path = request.url.pathname;
    return {
      kind: 'answer',
      status: 200,
      headers: { 'content-type': path === '/about' ? HTML : 'text/css' },
      body: new TextEncoder().encode(path === '/about' ? html : css(path + request.url.search)),
    };
  });
const captured = (transport: Transport) =>
  capturePage(ABOUT, { pool: POOL, resolve: resolverOf([PUBLIC_V4]), transport });
const [X, A, B] = ['x', 'css/a', 'css/b'].map((name) => `https://www.example.com/${name}.css`);
const chain = (path: string) => `@import "/d${Number(path.slice(2, 3)) + 1}.css";`;
const [FOLLOWED, NOT] = [[X, 'inline:0'], ['inline:0']];
const imported = (html: string, x = 'p{}') =>
  captured(
    served((path) => ({ '/x.css': x, '/css/a.css': '@import "b.css";' })[path] ?? 'p{}', html),
  );

describe('C80 hostile provider (capture path), imported sheets', () => {
  it('sees a change in a sheet a <style> imports as a stylesheet change', async () => {
    const html = '<style>@import "/x.css";</style><p>x</p>';
    const [one, two] = await Promise.all([imported(html), imported(html, 'p{display:none}')]);
    expect([one.ok && Object.keys(one.value.stylesheets), two.ok]).toEqual([FOLLOWED, true]);
    if (one.ok && two.ok) expect(one.value.stylesheets).not.toEqual(two.value.stylesheets);
  });

  it.each([
    ['<style>@import url(/x.css);</style>', FOLLOWED],
    ['<style>@import url( "/x.css" ) screen;</style>', FOLLOWED],
    ["<style>@IMPORT '/x.css' layer(a);</style>", FOLLOWED],
    ['<style>@\\69 mport "/x.css";</style>', FOLLOWED],
    ['<style>@import "/x\\2e css";</style>', FOLLOWED],
    ['<style>/* @import "/evil.css"; */@import/**/"/x.css";</style>', FOLLOWED],
    ['<style>a{content:"@import \'/evil.css\'"}</style>', NOT],
    ['<style>a{content:"\\"@import \'/evil.css\'"}</style>', NOT],
    ['<style>!!{background:u\\72l(/*)}@import "/x.css";/* */</style>', FOLLOWED],
    ['<style>#\\@import "/evil.css";</style>', NOT],
    ['<link rel=stylesheet href=/css/a.css>', [A, B]],
  ])('follows the imports of %s', async (region, keys) => {
    const result = await imported(`${region}<p>x</p>`);
    expect(result.ok && Object.keys(result.value.stylesheets)).toEqual(keys);
  });

  // Imports count against the cap and stop at a fixed depth, refused before anything more is fetched.
  it('refuses an import past the 32-sheet cap as oversized, fetching nothing more', async () => {
    const transport = served(
      (path) => (path === '/s.css?n=0' ? '@import "/more.css";' : 'p{}'),
      sheets(32).join(''),
    );
    expect(await captured(transport)).toEqual({ ok: false, code: 'CAPTURE_OVERSIZED' });
    const paths = transport.seen.map((seen) => seen.url.pathname);
    expect([paths.length, paths.includes('/more.css')]).toEqual([33, false]);
  });

  it('follows imports of imports to depth 3 and refuses the next as oversized', async () => {
    const transport = served(chain, '<link rel=stylesheet href=/d0.css>');
    expect(await captured(transport)).toEqual({ ok: false, code: 'CAPTURE_OVERSIZED' });
    expect(transport.seen.map((seen) => seen.url.pathname)).toEqual([
      '/about',
      '/d0.css',
      '/d1.css',
      '/d2.css',
      '/d3.css',
    ]);
  });
});

// The fourth re-bind, finding 3: the import reader differed from CSS's tokenizer, dropped an
// import it could not read, and read every sheet as UTF-8 whatever it declared. Each import sits
// in a linked /s.css; what a browser loads follows CSS Syntax 3 and the URL standard.
const S = 'https://www.example.com/s.css';
const linking = (css: string) =>
  captured(
    served((path) => (path === '/s.css' ? css : 'p{}'), '<link rel=stylesheet href=/s.css>'),
  );

describe('C80 hostile provider (capture path), imports read as CSS reads them', () => {
  it.each([
    ['@import url(/a\\ b.css);', '/a%20b.css'],
    ['@import url(/a\\"b.css);', '/a%22b.css'],
    ['@import url(/a\\(b.css);', '/a(b.css'],
    ['@import url(/a b.css);', '/a%C2%A0b.css'],
    ['@import url(/a.css );', '/a.css%C2%A0'],
    ['@import url(/a.css﻿);', '/a.css%EF%BB%BF'],
    ['@import "/a\0b.css";', '/a%EF%BF%BDb.css'],
    ['@import url(/a\0b.css);', '/a%EF%BF%BDb.css'],
    ['@import "/a.css\\', '/a.css'],
    ['@import url( /\\61 .css\t);', '/a.css'],
    ['@import url(/a.css', '/a.css'],
    ['@charset "windows-1252"; @import "/é.css";', 'malformed'],
    ['@import url(/a b.css);', 'malformed'],
    ['@import url(/a"b.css);', 'malformed'],
    ['@import "/a.css\n";', 'malformed'],
    ['@import /a.css;', 'malformed'],
    ['@import;', 'malformed'],
  ])('reads a sheet holding %j as a browser does: %s', async (css, path) => {
    const result = await linking(css);
    expect(result.ok ? Object.keys(result.value.stylesheets) : result.code).toEqual(
      path === 'malformed'
        ? 'CAPTURE_BODY_MALFORMED'
        : [S, `https://www.example.com${path}`].toSorted(),
    );
  });
});

describe('C80 hostile provider (capture path), charsets and long sheets', () => {
  it.each([
    [ABOUT, 'text/html; charset=iso-8859-1', false],
    [ABOUT, 'text/html; charset="utf-8;x"', false],
    [ABOUT, 'text/html; Charset=UTF8', true],
    [S, 'text/css; charset=windows-1252', false],
    [S, 'text/css;charset="UTF-8"', true],
  ] as const)('reads %s served as %s only as UTF-8: %s', async (url, type, ok) => {
    const transport = transportOf(() => answering(type, 'p{}'));
    const kind = url === S ? 'stylesheet' : 'document';
    expect((await fencedFetch(url, { ...options(transport), kind, page: ABOUT })).ok).toBe(ok);
  });

  // The reader stays linear: a hostile 1 MiB sheet answers at once, whatever it answers.
  it.each(['url(', 'url(a ', 'url(\\', '@import url(a b ', '@import ', '@import;', '"', '\\'])(
    'answers a 1 MiB sheet of %j within a second',
    async (shape) => {
      const started = performance.now();
      const result = await linking(shape.repeat(Math.floor(1_040_000 / shape.length)));
      expect(result.ok || result.code === 'CAPTURE_BODY_MALFORMED').toBe(true);
      expect(performance.now() - started).toBeLessThan(1000);
    },
  );
});
