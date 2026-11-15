// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs screen (#2493) on MP-1-7's width-and-theme harness, measured in the pinned browser at
// 1480, 900 and 390, light and dark: the folder tree beside the page above 640 and above it at
// 390, the page drawn read-only, and no sideways scroll. Each side is opened by `openSide` with
// the made-up session; the made-up reads (`made-up-api.ts`) draw the tree and the page, and the
// person's name is the one other read answered. The rest of the app frame is mp-2-8-harness's.

/* oxlint-disable no-await-in-loop -- one width and theme at a time, in order */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchChromium } from '../support/chromium.ts';
import { madeUpSession, serveApp } from '../visual/app-pages.ts';
import { load, openSide } from '../visual/capture.ts';
import { answerMadeUp } from '../visual/made-up-api.ts';
import { fetchAssets, MODE, readAssets, readPacket, themesOf } from '../visual/packet.ts';
import type { Packet, Theme } from '../visual/packet.ts';

const scratch = mkdtempSync(join(tmpdir(), 'docs-screen-'));
const WIDTHS = [1480, 900, 390] as const;

let packet: Packet;
let browser: Browser | undefined;
let served: { app: URL; close: () => Promise<void> } | undefined;
let session = '';
let themes: Theme[] = [];

beforeAll(async () => {
  packet = readPacket();
  await fetchAssets(readAssets(), packet);
  // No browser, no capture: the launch fails the suite, never skips it.
  browser = await launchChromium(MODE);
  served = await serveApp();
  session = madeUpSession(served.app, join(scratch, 'session'));
  themes = themesOf(packet);
  expect(themes).toEqual(['light', 'dark']);
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await served?.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Every width in every theme, one at a time. */
async function each(look: (width: number, theme: Theme, at: string) => Promise<void>) {
  for (const width of WIDTHS)
    for (const theme of themes) await look(width, theme, `${width} ${theme}`);
}

/** /docs/ at one width in one theme, signed in as Mia Hart, the made-up reads answered. */
async function open(width: number, theme: Theme): Promise<Page> {
  if (browser === undefined || served === undefined) throw new Error('the harness did not start');
  const { app } = served;
  const side = await openSide(browser, packet, width, { app, session, colorScheme: theme });
  // Registered after the side's own routes, so these run first.
  await answerMadeUp(side.context);
  await side.context.route('**/api/b/alpha/session/person', (route) =>
    route.fulfill({ json: { ok: true, person: { name: 'Mia Hart' } } }),
  );
  const page = await load(side, packet, new URL('/docs/', app).href);
  page.on('close', () => {
    side.context.close().catch(() => {});
  });
  return page;
}

const box = (page: Page, selector: string): Promise<DOMRect> =>
  page.$eval(selector, (el) => el.getBoundingClientRect().toJSON() as DOMRect);
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);

it('Docs harness leg: the folder tree beside the page above 640 and above it at 390, the page drawn read-only, light and dark, no sideways scroll', async () => {
  await each(async (width, theme, at) => {
    const page = await open(width, theme);
    await page.locator('[data-page-id="p-first-week"]').click();
    await page.locator('article .md__h').waitFor();
    expect(await page.locator('article .md__h').textContent(), at).toBe('Welcome');
    expect(await page.locator('article textarea, article [contenteditable]').count(), at).toBe(0);
    const tree = await box(page, '.docs__tree');
    const read = await box(page, '.docs__page');
    if (width > 640)
      expect(read.left, `page beside the tree at ${at}`).toBeGreaterThan(tree.right - 1);
    else expect(read.top, `page under the tree at ${at}`).toBeGreaterThan(tree.bottom - 1);
    const rail = await page.locator('.rail__item').allTextContents();
    if (width > 900) expect(rail.join(' '), `rail at ${at}`).toContain('Docs');
    expect(await sideways(page), `no sideways scroll at ${at}`).toBeLessThanOrEqual(width);
    await page.close();
  });
}, 600_000);
