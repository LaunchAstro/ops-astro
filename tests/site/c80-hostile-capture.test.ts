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
    [
      {
        kind: 'answer',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new Uint8Array([123]),
      } as const,
      'CAPTURE_BODY_MALFORMED',
    ],
    [
      {
        kind: 'answer',
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: new Uint8Array([0xff, 0xfe, 0xfd]),
      } as const,
      'CAPTURE_BODY_MALFORMED',
    ],
    [
      {
        kind: 'answer',
        status: 500,
        headers: { 'content-type': 'text/html' },
        body: new Uint8Array(),
      } as const,
      'CAPTURE_STATUS_REFUSED',
    ],
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
      headers: { 'content-type': request.url.pathname === '/about' ? 'text/html' : 'text/css' },
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
      headers: { 'content-type': path === '/about' ? 'text/html' : 'text/css' },
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
