// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 capture picture, in a real browser: headless Chromium with JavaScript
// left ON, every request intercepted and handed to the product's route. The
// page's inline script still does not run (the document's policy, not the
// browser's setting, stops it), the image on another host and the frame never
// load, and the only requests that reach the transport are the page and its
// stylesheet. The page's host does not resolve anywhere: a request that
// escaped the route would fail the load.
//
// Skipped, with a warning, where no Chromium is installed (CI installs none
// today); the scripted run in c80-picture.test.ts holds the route's rules there.

import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capturePicture, type PictureBrowser } from '../../packages/core-connectors/src/index.ts';
import { ABOUT, POOL, SHEET, publicResolver, site } from './c80-picture-world.ts';

const installed = existsSync(chromium.executablePath());
if (!installed)
  console.warn('C80 capture picture (browser): no Chromium installed, so nothing ran.');

let browser: Browser;
beforeAll(async () => {
  if (installed) browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  if (installed) await browser.close();
});

/** The worker's browser port, as a real one: every request goes to the route. */
function chromiumPort(probe: { ran?: string | null }): PictureBrowser {
  return async (url, route) => {
    const context = await browser.newContext({ javaScriptEnabled: true, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      await page.route('**/*', async (intercepted) => {
        const request = intercepted.request();
        const answer = await route({
          url: request.url(),
          kind: request.resourceType(),
          mainFrame: request.isNavigationRequest() && request.frame() === page.mainFrame(),
        });
        await (answer === undefined
          ? intercepted.abort()
          : intercepted.fulfill({
              status: answer.status,
              headers: answer.headers,
              body: answer.body,
            }));
      });
      await page.goto(url, { waitUntil: 'load' });
      probe.ran = await page.getAttribute('html', 'data-ran');
      return new Uint8Array(await page.screenshot({ fullPage: true }));
    } finally {
      await context.close();
    }
  };
}

describe.skipIf(!installed)('C80 capture picture, in a real browser', () => {
  it('renders through the fence alone, and the page runs no script', async () => {
    const transport = site();
    const probe: { ran?: string | null } = {};
    const picture = await capturePicture(
      ABOUT,
      { pool: POOL, resolve: publicResolver, transport },
      chromiumPort(probe),
    );
    if (!picture.ok) throw new Error(`the picture failed: ${picture.code}`);
    expect(Array.from(picture.value.png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(picture.value.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(probe.ran).toBeNull();
    expect(transport.seen.toSorted()).toEqual([ABOUT, SHEET]);
    expect(picture.value.refused.map((refusal) => refusal.origin)).toContain(
      'https://tracker.example.net',
    );
  }, 60_000);
});
