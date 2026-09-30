// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-1 on the app as it ships: built for production, served by Vite's
// preview with its content policy (S0-6c, script-src 'self') in force, and
// opened in a dark browser. The theme step must run under that policy and
// before the parser reaches the body, so nothing the body draws is painted
// without data-theme. A step the policy refuses leaves the root unmarked.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { afterAll, expect, it } from 'vitest';
import { launchChromium } from '../support/chromium.ts';

const configFile = fileURLToPath(new URL('../../apps/web/vite.config.ts', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mp-1-1-theme-'));
afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

interface Seen {
  themeAtBody?: string | null;
  refused: string[];
}

/** In a dark browser: the root's theme when the body first exists, and what the policy refused. */
async function seenOn(origin: string): Promise<Seen> {
  const browser = await launchChromium();
  try {
    const page = await (await browser.newContext({ colorScheme: 'dark' })).newPage();
    await page.addInitScript(() => {
      const seen: Seen = { refused: [] };
      Object.assign(window, { seen });
      document.addEventListener('securitypolicyviolation', (event) => {
        seen.refused.push(event.violatedDirective);
      });
      new MutationObserver((_records, observer) => {
        if (document.body === null) return;
        seen.themeAtBody = document.documentElement.getAttribute('data-theme');
        observer.disconnect();
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(`${origin}/`, { waitUntil: 'load' });
    return await page.evaluate(() => (window as unknown as { seen: Seen }).seen);
  } finally {
    await browser.close();
  }
}

it('MP-1-1 the built app marks a dark root before the body, under its own content policy', async () => {
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
    const seen = await seenOn(`http://127.0.0.1:${String(address.port)}`);
    expect(seen.refused).toEqual([]);
    expect(seen.themeAtBody).toBe('dark');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}, 120_000);
