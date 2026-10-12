// SPDX-License-Identifier: AGPL-3.0-only
//
// The search dialog, the task editor over the floating dock, and a dock
// panel's late scroll, in real Chromium: `node tests/surfaces/search-and-dock-in-a-browser-check.mjs`
// with Playwright's Chromium installed. Sol's check, kept as written.
/* oxlint-disable no-await-in-loop -- Sol's check, kept as written */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const server = await createServer({
  configFile: false,
  plugins: [react()],
  optimizeDeps: { entries: ['tests/surfaces/search-and-dock-in-a-browser-entry.mjs'] },
  resolve: { alias: { '@launchastro/ui': resolve('packages/ui/src/index.ts') } },
  server: { host: '127.0.0.1', port: 5179, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
page.on('pageerror', (error) => console.error(error.message));
page.on('requestfailed', (request) => console.error(request.url(), request.failure()));
page.on('console', (message) => {
  if (message.type() === 'error') console.error(message.text());
});
let failures = 0;
async function check(name, run) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}
try {
  await page.goto('http://127.0.0.1:5179/tests/surfaces/search-and-dock-in-a-browser.html');
  await page.waitForFunction(() => window.ready === true);
  await page.evaluate(() => window.paintApp());
  await page.locator('.appbar__search').waitFor();
  await check('Tab and Shift+Tab stay in the real search dialog', async () => {
    await page.locator('.appbar__search').click();
    await page.locator('.palette input').waitFor();
    for (const key of ['Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      assert.equal(
        await page.evaluate(() => document.activeElement.matches('.palette input')),
        true,
      );
    }
    assert.equal(await page.locator('.shell').getAttribute('inert'), '');
    await page.evaluate(() => document.querySelector('.appbar__search').focus());
    assert.equal(await page.evaluate(() => document.activeElement.matches('.palette input')), true);
  });
  await check('closing search restores focus to its trigger', async () => {
    await page.keyboard.press('Escape');
    await page.locator('.palette').waitFor({ state: 'detached' });
    const active = await page.evaluate(() => ({
      tag: document.activeElement.tagName,
      className: document.activeElement.className,
    }));
    assert.equal(
      active.className.includes('appbar__search'),
      true,
      `the search trigger must receive focus when the dialog closes, received ${JSON.stringify(active)}`,
    );
  });
  await check('the real task editor receives hits over the floating dock', async () => {
    await page.locator('.task-controls summary').click();
    await page.locator('.dock__tab[data-panel="todos"]').click();
    assert.equal(await page.locator('.dock').getAttribute('data-mode'), 'floating');
    const result = await page.locator('#task-title').evaluate((input) => {
      const box = input.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        hit: hit === input || input.contains(hit),
        x: box.x,
        right: box.right,
        dockLeft: document.querySelector('.dpanel').getBoundingClientRect().left,
      };
    });
    assert.ok(result.right > result.dockLeft, 'the test input must overlap the floating panel');
    assert.equal(result.hit, true, JSON.stringify(result));
  });
  await check('late content restores a real panel scroll after Back', async () => {
    await page.evaluate(() => window.paintScroll());
    await page.locator('.dpanel__body li').first().waitFor();
    await page.evaluate(() => {
      const body = document.querySelector('.dpanel__body');
      body.style.height = '200px';
      body.style.flex = 'none';
      body.scrollTop = 600;
    });
    assert.equal(await page.locator('.dpanel__body').evaluate((body) => body.scrollTop), 600);
    await page.evaluate(() => window.away());
    await page.locator('.dpanel__body').waitFor({ state: 'detached' });
    await page.evaluate(() => window.back());
    await page.locator('.dpanel__body').waitFor();
    assert.equal(await page.locator('.dpanel__body').evaluate((body) => body.scrollTop), 0);
    await page.evaluate(() => {
      const body = document.querySelector('.dpanel__body');
      body.style.height = '200px';
      body.style.flex = 'none';
      window.resolveRead();
    });
    await page.waitForFunction(() => document.querySelector('.dpanel__body').scrollTop === 600);
  });
} finally {
  await browser.close();
  await server.close();
}
process.exitCode = failures === 0 ? 0 : 1;
