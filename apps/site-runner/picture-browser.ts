// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's picture browser (#2013, C35): headless Chromium, as the capture's
// `PictureBrowser` port asks for it (`core-connectors/src/capture/picture.ts`). Each picture
// is its own browser, started with PICTURE_BROWSER_ARGS so it has no network of its own, and
// one fresh context in it: a window of the width asked and a set height, no script, service
// workers blocked, no cookie or credential. Every request it makes is handed to the fence's
// route, which answers it or refuses it. The browser is closed whether the picture is taken
// or not, so a failed capture leaves no process behind. With no Chromium installed the
// picture fails, and the capture with it.

import { chromium } from 'playwright';
import type { PictureBrowser } from '../../packages/core-connectors/src/index.ts';
import { PICTURE_BROWSER_ARGS } from '../../packages/core-connectors/src/index.ts';
import type { CaptureWidth } from '../../packages/core-records/src/index.ts';

/** Each width's window height: a laptop's at 1480, a phone's at 390. */
export const CAPTURE_HEIGHTS: Readonly<Record<CaptureWidth, number>> = { 1480: 900, 390: 844 };

/** The longest a picture's page may take to load. */
const LOAD_TIMEOUT_MS = 30_000;

export const chromiumAt =
  (width: CaptureWidth): PictureBrowser =>
  async (url, route) => {
    const browser = await chromium.launch({ headless: true, args: [...PICTURE_BROWSER_ARGS] });
    try {
      const context = await browser.newContext({
        viewport: { width, height: CAPTURE_HEIGHTS[width] },
        javaScriptEnabled: false,
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      await page.route('**/*', async (intercepted) => {
        const request = intercepted.request();
        const answer = await route({
          url: request.url(),
          kind: request.resourceType(),
          mainFrame: request.isNavigationRequest() && request.frame() === page.mainFrame(),
        });
        await (answer === null
          ? intercepted.abort()
          : intercepted.fulfill({
              status: answer.status,
              headers: answer.headers,
              body: answer.body,
            }));
      });
      await page.goto(url, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
      return new Uint8Array(await page.screenshot({ type: 'png' }));
    } finally {
      await browser.close();
    }
  };
