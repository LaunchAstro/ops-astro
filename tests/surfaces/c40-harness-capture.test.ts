// SPDX-License-Identifier: AGPL-3.0-only
//
// C40's two pages on the width-and-theme harness (MP-1-7): the Forgot password
// page and the Set password page a reset link opens, each drawn signed out, in
// light and dark at 1480, 900 and 390, in the pinned headless shell. The Set
// password page is loaded with a made-up link (`PAGE_FRAGMENTS`), so it draws
// its form and asks the provider nothing until the form is sent. Each capture
// checks the page drew its own form. No browser, no capture: the launch fails
// the test, never skips it.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { launchChromium } from '../support/chromium.ts';
import {
  captureBuiltPages,
  MADE_UP_PARAMS,
  madeUpSession,
  PAGE_FRAGMENTS,
  serveApp,
} from '../visual/app-pages.ts';
import { load, openSide } from '../visual/capture.ts';
import { comparePng } from '../visual/compare.ts';
import { fetchAssets, MODE, readAssets, readPacket, themesOf } from '../visual/packet.ts';
import { addressOf, report } from '../visual/report.ts';

const scratch = mkdtempSync(join(tmpdir(), 'c40-captures-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const WIDTHS = [1480, 900, 390];
const PAGES = {
  'agency:forgot-password': '[data-reset="ask"]',
  'agency:reset': '[data-reset="form"]',
};

describe('C40 pages on the width-and-theme harness (MP-1-7)', () => {
  it('C40 harness capture: Forgot password and Set password, signed out, in light and dark at 1480, 900 and 390', async () => {
    const packet = readPacket();
    await fetchAssets(readAssets(), packet);
    const browser = await launchChromium(MODE);
    const { app, close } = await serveApp();
    try {
      const out = join(scratch, 'c40');
      const session = madeUpSession(app, out);
      const themes = themesOf(packet);
      expect(themes).toContain('dark');
      const pages = Object.keys(PAGES);
      const shots = await captureBuiltPages({
        browser,
        packet,
        app,
        session,
        widths: WIDTHS,
        themes,
        out,
        pages,
      });
      const all = report({ ...packet, widths: WIDTHS }, pages, shots);
      expect(all.failed, all.lines.join('\n')).toBe(0);
      for (const page of pages) {
        const file = (width: number, theme: string): Buffer =>
          readFileSync(join(out, `${page}@${width}-${theme}.page.png`));
        for (const width of WIDTHS) {
          expect(all.lines).toContain(
            `ok ${page}@${width}-dark: ${page}@${width}-dark.page.png; no sideways scroll`,
          );
          const same = comparePng(`${page}@${width}`, file(width, 'light'), file(width, 'dark'));
          expect(same.pass, `${page}@${width} dark draws the same as light`).toBe(false);
        }
      }
      // The pictures are of each page's own form, drawn signed out.
      const side = await openSide(browser, packet, 390, { app });
      try {
        for (const [page, drawn] of Object.entries(PAGES)) {
          const address = `${addressOf(page, MADE_UP_PARAMS) ?? '/'}${PAGE_FRAGMENTS[page] ?? ''}`;
          // oxlint-disable-next-line no-await-in-loop
          const shown = await load(side, packet, new URL(address, app).href);
          // oxlint-disable-next-line no-await-in-loop
          await shown.waitForSelector(drawn, { timeout: 10_000 });
          // oxlint-disable-next-line no-await-in-loop
          expect(await shown.locator(drawn).count(), page).toBe(1);
          // oxlint-disable-next-line no-await-in-loop
          await shown.close();
        }
      } finally {
        await side.context.close();
      }
    } finally {
      await browser.close();
      await close();
    }
  }, 600_000);
});
