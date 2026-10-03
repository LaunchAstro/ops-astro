// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function -- Sol's proof body, committed unchanged */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { launchChromium } from '../support/chromium.ts';
import { madeUpSession, serveApp } from '../visual/app-pages.ts';
import { openSide } from '../visual/capture.ts';
import { answerMadeUp } from '../visual/made-up-api.ts';
import { fetchAssets, readPacket } from '../visual/packet.ts';

// Sol OW-127 correctness, retitled by what it proves; its body is Sol's.
it('Sign out stays clickable above a floating dock', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sol-ow127-'));
  const packet = readPacket();
  await fetchAssets();
  const browser = await launchChromium();
  const { app, close } = await serveApp();
  try {
    const side = await openSide(browser, packet, 1480, {
      app,
      session: madeUpSession(app, scratch),
    });
    await answerMadeUp(side.context);
    const page = await side.context.newPage();
    await page.goto(new URL('/projects/', app).href);
    await page.locator('.who__trigger').waitFor();
    await page.locator('.who__trigger').click();
    const initial = page.getByRole('menuitem', { name: 'Sign out', exact: true });
    await initial.waitFor();
    expect(
      await initial.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return top !== null && element.contains(top);
      }),
      'Control: Sign out receives pointer clicks with the dock closed',
    ).toBe(true);
    await page.keyboard.press('Escape');
    await page.locator('.dock__tab[data-panel="ai"]').click();
    await page.locator('.dock[data-mode="floating"] .dpanel').waitFor();
    await page.locator('.who__trigger').click();
    const signOut = page.getByRole('menuitem', { name: 'Sign out', exact: true });
    await signOut.waitFor();
    const receivesPointer = await signOut.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { clickable: top !== null && element.contains(top), coveredBy: top?.className };
    });
    expect(
      receivesPointer,
      `Sign out must receive a normal pointer click: ${JSON.stringify(receivesPointer)}`,
    ).toMatchObject({ clickable: true });
    await signOut.click({ timeout: 2000 });
    await page.locator('.signin__form').waitFor();
    await side.context.close();
  } finally {
    await browser.close();
    await close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
