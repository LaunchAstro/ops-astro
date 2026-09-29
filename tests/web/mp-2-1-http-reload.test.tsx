// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-1 hard reload, over HTTP (Sol, review 1 on #119). A reload is a request
// for the address itself, so the web server has to answer every manifest
// address, and every legacy one, with the application rather than a 404. This
// starts the real dev server from `apps/web/vite.config.ts` on a free port and
// asks it for each one, as a browser's reload does. Which page the
// application then draws at that address is `mp-2-1-route-manifest.test.tsx`'s
// `MP-2-1 hard reload`. Staging's host rewrite arrives with S0-1.
//
// Each server gets a dependency cache folder of its own, empty, so every run
// starts cold as a fresh checkout and CI do. A warm cache left by an earlier
// run hid a close that never finished; the close is bounded so that shows as
// a failure rather than a hook timeout.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { PAGES } from '../../apps/web/src/manifest.ts';
import { filled } from './mp-2-1-support.tsx';

const CLOSE_WITHIN_MS = 5_000;

interface DevServer {
  readonly origin: string;
  /** Rejects if the server is still closing after `CLOSE_WITHIN_MS`. */
  readonly close: () => Promise<void>;
}

async function startDevServer(): Promise<DevServer> {
  const cacheDir = mkdtempSync(join(resolve('apps/web/node_modules'), '.vite-reload-'));
  const server = await createServer({
    configFile: resolve('apps/web/vite.config.ts'),
    cacheDir,
    server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false },
    logLevel: 'silent',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('the dev server has no port');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`the dev server was still closing after ${String(CLOSE_WITHIN_MS)} ms`));
        }, CLOSE_WITHIN_MS);
      });
      try {
        await Promise.race([server.close(), late]);
      } finally {
        clearTimeout(timer);
        rmSync(cacheDir, { recursive: true, force: true });
      }
    },
  };
}

const reload = async (
  origin: string,
  address: string,
): Promise<{ status: number; html: string }> => {
  const response = await fetch(`${origin}${address}`, { headers: { accept: 'text/html' } });
  return { status: response.status, html: await response.text() };
};

const LEGACY = '/client-portal/channel-workbench/?client=acme-dental';

describe('MP-2-1 hard reload', () => {
  let server: DevServer | undefined;

  beforeAll(async () => {
    server = await startDevServer();
  }, 60_000);

  afterAll(async () => await server?.close());

  it('answers every manifest address with the application', async () => {
    const origin = server?.origin ?? '';
    const answers = await Promise.all(
      PAGES.map(async (page) => await reload(origin, filled(page.path))),
    );
    for (const [index, answer] of answers.entries()) {
      const address = filled(PAGES[index]?.path ?? '');
      expect(answer.status, address).toBe(200);
      expect(answer.html, address).toContain('id="app"');
    }
  });

  it('answers a legacy address with the application, which then redirects it', async () => {
    const answer = await reload(server?.origin ?? '', LEGACY);
    expect(answer.status).toBe(200);
    expect(answer.html).toContain('id="app"');
  });
});

describe('MP-2-1 hard reload, the dev server', () => {
  it('closes within 5 s after a reload of every address', async () => {
    const server = await startDevServer();
    const addresses = [...PAGES.map((page) => filled(page.path)), LEGACY];
    await Promise.all(addresses.map(async (address) => await reload(server.origin, address)));
    await expect(server.close()).resolves.toBeUndefined();
  }, 60_000);
});
