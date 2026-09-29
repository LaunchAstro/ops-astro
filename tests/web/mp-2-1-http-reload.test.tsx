// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-1 hard reload, over HTTP (Sol, review 1 on #119). A reload is a request
// for the address itself, so the web server has to answer every manifest
// address, and every legacy one, with the application rather than a 404. This
// starts the real dev server from `apps/web/vite.config.ts` on a free port and
// asks it for each one, as a browser's reload does. Which page the
// application then draws at that address is `mp-2-1-route-manifest.test.tsx`'s
// `MP-2-1 hard reload`. Staging's host rewrite arrives with S0-1.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { PAGES } from '../../apps/web/src/manifest.ts';
import { filled } from './mp-2-1-support.tsx';

describe('MP-2-1 hard reload', () => {
  let server: ViteDevServer;
  let origin = '';

  beforeAll(async () => {
    server = await createServer({
      configFile: resolve('apps/web/vite.config.ts'),
      server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false },
      logLevel: 'silent',
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (address === null || address === undefined || typeof address === 'string') {
      throw new Error('the dev server has no port');
    }
    origin = `http://127.0.0.1:${String(address.port)}`;
  }, 60_000);

  afterAll(async () => await server?.close());

  const reload = async (address: string): Promise<{ status: number; html: string }> => {
    const response = await fetch(`${origin}${address}`, { headers: { accept: 'text/html' } });
    return { status: response.status, html: await response.text() };
  };

  it('answers every manifest address with the application', async () => {
    const answers = await Promise.all(PAGES.map(async (page) => await reload(filled(page.path))));
    for (const [index, answer] of answers.entries()) {
      const address = filled(PAGES[index]?.path ?? '');
      expect(answer.status, address).toBe(200);
      expect(answer.html, address).toContain('id="app"');
    }
  });

  it('answers a legacy address with the application, which then redirects it', async () => {
    const answer = await reload('/client-portal/channel-workbench/?client=acme-dental');
    expect(answer.status).toBe(200);
    expect(answer.html).toContain('id="app"');
  });
});
