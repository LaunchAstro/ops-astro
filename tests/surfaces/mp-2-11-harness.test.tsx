// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-11 on MP-1-7's width-and-theme harness: Settings General (`/settings`)
// drawn in a real browser at 1480, 900 and 390, light and dark, each picture
// as wide as its width with no sideways scroll, and dark drawn differently
// from light. The same capture as MP-1-1's every-built-page case, narrowed to
// this ticket's page so its own check names it.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { afterAll, expect, it } from 'vitest';
import { captureBuiltPages, madeUpSession, serveApp } from '../visual/app-pages.ts';
import { comparePng } from '../visual/compare.ts';
import { fetchAssets, MODE, readAssets, readPacket, themesOf } from '../visual/packet.ts';
import { report } from '../visual/report.ts';

const scratch = mkdtempSync(join(tmpdir(), 'mp-2-11-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const PAGE = 'agency:settings';

it('MP-2-11 harness captures: /settings in light and dark at 1480, 900 and 390', async () => {
  const packet = readPacket();
  const widths = [1480, 900, 390];
  await fetchAssets(readAssets(), packet);
  // No browser, no capture: the launch fails the test, never skips it.
  const browser = await chromium.launch(MODE);
  const { app, close } = await serveApp();
  try {
    const out = join(scratch, 'captures');
    const session = madeUpSession(app, out);
    const themes = themesOf(packet);
    expect(themes).toEqual(expect.arrayContaining(['light', 'dark']));
    const shots = await captureBuiltPages({
      browser,
      packet,
      app,
      session,
      widths,
      themes,
      out,
      pages: [PAGE],
    });
    const all = report({ ...packet, widths }, [PAGE], shots);
    expect(all.failed).toBe(0);
    for (const width of widths) {
      for (const theme of ['light', 'dark'])
        expect(all.lines).toContain(
          `ok ${PAGE}@${width}-${theme}: ${PAGE}@${width}-${theme}.page.png; no sideways scroll`,
        );
      const file = (theme: string): Buffer =>
        readFileSync(join(out, `${PAGE}@${width}-${theme}.page.png`));
      const same = comparePng(`${PAGE}@${width}`, file('light'), file('dark'));
      expect(same.pass, `${PAGE}@${width} dark draws the same as light`).toBe(false);
    }
  } finally {
    await browser.close();
    await close();
  }
}, 600_000);
