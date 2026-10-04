// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop -- widths and themes run one at a time, in
   order: one browser context at a time, so each view is measured alone. */
//
// The component gallery (MP-1-3) drawn in a real browser at each width in
// each theme, for the visual-match legs of U04's tickets (MP-1-2, MP-1-3,
// MP-1-6). The app is served from source and signed in with the made-up
// session (`app-pages.ts`); the pinned headless shell draws it with the
// bundled faces proved in use (`load`). No browser: the launch throws, so a
// test on these views fails and never passes without drawing.
//
// What this measures runs in the required checks. The pixel comparison with
// the private mockup does not (ruling (a)): `run.ts` with MOCKUP_DIR, locally.

import type { Page } from 'playwright';
import { withSignedInApp } from './app-pages.ts';
import { load, openSide } from './capture.ts';
import { scrollMetrics } from './drift.ts';
import { themesOf, type Theme } from './packet.ts';
import { addressOf, overflowOf } from './report.ts';

/** T4c's three capture widths: desktop, tablet and phone. */
export const WIDTHS = [1480, 900, 390] as const;

export type GalleryView = { width: number; theme: Theme; page: Page; sideways: number };

/** Opens the gallery at each width in each theme and hands each view to `measure`. */
export function eachGalleryView(measure: (view: GalleryView) => Promise<void>): Promise<void> {
  return withSignedInApp(async ({ browser, packet, app, session }) => {
    const url = new URL(addressOf('agency:gallery', {}) ?? '', app).href;
    for (const width of WIDTHS) {
      for (const theme of themesOf(packet)) {
        const side = await openSide(browser, packet, width, { app, session, colorScheme: theme });
        try {
          const page = await load(side, packet, url);
          const sideways = overflowOf(await page.evaluate(scrollMetrics));
          await measure({ width, theme, page, sideways });
        } finally {
          await side.context.close();
        }
      }
    }
  });
}

/** One gallery entry's picture, by its catalogue id. */
export function entryPicture(page: Page, id: string): Promise<Buffer> {
  const entry = page.locator(`[data-catalogue-id="${id}"]`).first();
  return entry.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
}
