// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-2's fonts as the product ships them: the web app built for
// production and served by Vite's preview, opened in a plain browser with no
// visual-harness faces injected (tests/visual/capture.ts adds bundled TTFs to
// the pages it draws, so its font check alone cannot show what the app
// requests). Each family must arrive as the app's own request for the
// licensed file its package installs, byte for byte, and load.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { afterAll, expect, it } from 'vitest';

const ui = fileURLToPath(new URL('../../packages/ui/node_modules/', import.meta.url));
const configFile = fileURLToPath(new URL('../../apps/web/vite.config.ts', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mp-1-2-fonts-'));
afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

/** Each family, a weight the tokens draw, and the installed file that face must be. */
const FACES = [
  {
    family: 'Funnel Display',
    load: '500 16px "Funnel Display"',
    file: '@fontsource/funnel-display/files/funnel-display-latin-500-normal.woff2',
  },
  {
    family: 'Funnel Sans',
    load: '400 16px "Funnel Sans"',
    file: '@fontsource-variable/funnel-sans/files/funnel-sans-latin-wght-normal.woff2',
  },
  {
    family: 'Chivo Mono',
    load: '300 11px "Chivo Mono"',
    file: '@fontsource-variable/chivo-mono/files/chivo-mono-latin-wght-normal.woff2',
  },
] as const;

type Fetched = { url: string; status: number; body: Buffer };

/** The built file's name: the installed name with Vite's content hash before the extension. */
const built = (file: string): RegExp => {
  const name = (file.split('/').at(-1) ?? '').replace(/\.woff2$/u, '');
  return new RegExp(`/${name}-[^/]+\\.woff2(?:\\?|$)`, 'u');
};

/** In a plain browser on the served build: the families that load, and every font it fetched. */
async function fontsServed(origin: string): Promise<{ loaded: string[]; fonts: Fetched[] }> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const pending: Promise<Fetched>[] = [];
    page.on('response', (response) => {
      if (response.request().resourceType() !== 'font') return;
      pending.push(
        response.body().then((body) => ({ url: response.url(), status: response.status(), body })),
      );
    });
    await page.goto(`${origin}/`, { waitUntil: 'load' });
    const loaded = await page.evaluate(
      async (faces) =>
        (
          await Promise.all(
            faces.map(async (face) => ({
              family: face.family,
              drawn: await document.fonts.load(face.load),
            })),
          )
        )
          .filter((face) => face.drawn.some((f) => f.status === 'loaded'))
          .map((face) => face.family),
      FACES,
    );
    return { loaded, fonts: await Promise.all(pending) };
  } finally {
    await browser.close();
  }
}

it('MP-1-2 the built app requests and loads its own licensed font files, with no injected face', async () => {
  await build({ configFile, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  const server = await preview({
    configFile,
    logLevel: 'silent',
    build: { outDir },
    preview: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  try {
    const address = server.httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('no preview port');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const { loaded, fonts } = await fontsServed(origin);
    expect(loaded).toEqual(FACES.map((face) => face.family));
    // Every font the page fetched is one of the app's own woff2 files; nothing else supplies a face.
    expect(fonts.length).toBeGreaterThanOrEqual(FACES.length);
    for (const font of fonts) {
      expect(font.url.startsWith(`${origin}/`), font.url).toBe(true);
      expect(font.url, 'a font the app does not bundle').toMatch(/\.woff2(?:\?|$)/u);
    }
    for (const face of FACES) {
      const font = fonts.find((f) => built(face.file).test(f.url));
      expect(font?.status, `${face.family}: ${face.file} requested`).toBe(200);
      expect(font?.body, `${face.family}: the installed bytes`).toEqual(
        readFileSync(`${ui}${face.file}`),
      );
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}, 120_000);
