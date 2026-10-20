// SPDX-License-Identifier: AGPL-3.0-only
//
// A page's content policy is a `<meta>` (apps/web/index.html), and a `<meta>`
// cannot carry `frame-ancestors`, so another site may only be refused a frame
// by headers on the response. Asked of each place the pages are served: the
// hosted build output `scripts/ops/release.ts` writes, its `config.json` read
// as Vercel reads its routes, and the dev and preview servers
// `apps/web/vite.config.ts` starts, each started and asked over HTTP.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, preview } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { release } from '../../scripts/ops/release.ts';

const scratch = mkdtempSync(join(tmpdir(), 'served-framing-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CONFIG_FILE = fileURLToPath(new URL('../../apps/web/vite.config.ts', import.meta.url));
const PORT = 54_958;
const PAGES = ['/', '/task/OPS-1'];

/** A page's framing headers, as a browser reads them. */
const framing = (headers: Headers) => ({
  policy: headers.get('content-security-policy'),
  frameOptions: headers.get('x-frame-options'),
});
const REFUSED = { policy: "frame-ancestors 'none'", frameOptions: 'DENY' };

interface Route {
  readonly src?: string;
  readonly handle?: string;
  readonly headers?: Record<string, string>;
  readonly continue?: boolean;
}

/**
 * The headers Vercel's routes give `path` before its filesystem phase serves
 * a static file: each matching route's headers, up to the first match that
 * does not continue.
 */
function routedHeaders(routes: readonly Route[], path: string): Headers {
  const headers = new Headers();
  for (const route of routes) {
    if (route.handle !== undefined) break;
    if (route.src === undefined || !new RegExp(route.src, 'u').test(path)) continue;
    for (const [name, value] of Object.entries(route.headers ?? {})) headers.set(name, value);
    if (route.continue !== true) break;
  }
  return headers;
}

/** Each page from the server on `PORT`: HTML, sent with both headers. */
async function expectPagesRefused(): Promise<void> {
  const answers = await Promise.all(
    PAGES.map(async (page) => await fetch(`http://127.0.0.1:${PORT}${page}`)),
  );
  answers.forEach((answer, index) => {
    expect(answer.headers.get('content-type'), PAGES[index]).toContain('text/html');
    expect(framing(answer.headers), PAGES[index]).toEqual(REFUSED);
  });
}

describe('served pages refuse to be framed by another site', () => {
  it('the hosted build output sends both headers on every page', async () => {
    const dist = join(scratch, 'dist');
    mkdirSync(dist);
    writeFileSync(join(dist, 'index.html'), '<!doctype html>');
    writeFileSync(join(dist, 'build.json'), JSON.stringify({ build: 'abcdef012345' }));
    const out = join(scratch, 'out');
    await release({ dist, out });
    const { routes } = JSON.parse(readFileSync(join(out, 'config.json'), 'utf8')) as {
      routes: Route[];
    };
    for (const page of [...PAGES, '/index.html']) {
      expect(framing(routedHeaders(routes, page)), page).toEqual(REFUSED);
    }
  }, 120_000);

  it('the dev server sends both headers on every page', async () => {
    const server = await createServer({
      configFile: CONFIG_FILE,
      logLevel: 'silent',
      server: { port: PORT },
    });
    await server.listen();
    try {
      await expectPagesRefused();
    } finally {
      await server.close();
    }
  }, 30_000);

  it('the preview server sends both headers on every page', async () => {
    const dist = join(scratch, 'preview');
    mkdirSync(dist);
    writeFileSync(join(dist, 'index.html'), '<!doctype html>');
    const server = await preview({
      configFile: CONFIG_FILE,
      logLevel: 'silent',
      build: { outDir: dist },
      preview: { host: '127.0.0.1', port: PORT, strictPort: true },
    });
    try {
      await expectPagesRefused();
    } finally {
      await server.close();
    }
  }, 30_000);
});
