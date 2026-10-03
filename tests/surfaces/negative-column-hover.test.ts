// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { launchChromium } from '../support/chromium.ts';

// Sol OW-103.1 correctness, retitled by what it proves; its body is Sol's.
it('hovering a negative column shows its value', async () => {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const address = server.resolvedUrls?.local[0];
    if (address === undefined) throw new Error('proof server has no address');
    const page = await browser.newPage();
    await page.goto(`${address}tests/surfaces/negative-column-hover.html`);
    const bar = page.locator('.chart__bar').first();
    await bar.waitFor();
    const point = page.locator('.chart__hit').first();
    await point.focus();
    await expect.poll(() => page.locator('[role="tooltip"]').textContent()).toBe('MonRefunds -$30');
    await point.blur();
    expect(await page.locator('[role="tooltip"]').count()).toBe(0);
    const box = await bar.boundingBox();
    if (box === null || box.height <= 0) throw new Error('negative bar was not drawn');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect
      .poll(
        () =>
          page
            .locator('[role="tooltip"]')
            .textContent({ timeout: 200 })
            .catch(() => null),
        { timeout: 2000 },
      )
      .toBe('MonRefunds -$30');
  } finally {
    await browser.close();
    await server.close();
  }
}, 30_000);
