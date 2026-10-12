// SPDX-License-Identifier: AGPL-3.0-only
// Proofs from the independent review of #1408 (round 1), retitled by what they prove; their bodies are as written.
import { beforeAll, afterAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

let server: ViteDevServer;
let browser: Browser;
let origin: string;
beforeAll(async () => {
  server = await createServer({
    configFile: false,
    plugins: [react()],
    server: { host: '0.0.0.0', port: 0, allowedHosts: ['host.docker.internal'] },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (typeof address !== 'object' || address === null) throw new Error('no proof server');
  origin = `http://${process.env['SOL_BROWSER_HOST'] ?? '127.0.0.1'}:${address.port}`;
  const remote = process.env['SOL_BROWSER_WS'];
  browser = remote === undefined ? await chromium.launch() : await chromium.connect(remote);
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

it('Chromium Escape retains an unmatched query and Enter commits it', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/tests/browser/board-search-escape.html`);
    const field = page.locator('[data-board-search]');
    await field.fill('quokka');
    expect(await field.getAttribute('aria-expanded')).toBe('false');
    await field.press('Escape');
    expect(await field.getAttribute('aria-expanded')).toBe('false');
    expect(await field.inputValue()).toBe('quokka');
    await field.press('Enter');
    expect(await page.locator('output').textContent()).toBe('quokka');
  } finally {
    await page.close();
  }
}, 30_000);

it('Chromium Escape closes matching suggestions without clearing the query', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/tests/browser/board-search-escape.html`);
    const field = page.locator('[data-board-search]');
    await field.fill('zeb');
    expect(await field.getAttribute('aria-expanded')).toBe('true');
    await field.press('Escape');
    expect(await field.getAttribute('aria-expanded')).toBe('false');
    expect(await field.inputValue()).toBe('zeb');
    await field.press('Enter');
    expect(await page.locator('output').textContent()).toBe('zeb');
  } finally {
    await page.close();
  }
}, 30_000);
