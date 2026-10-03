// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function, unicorn/prefer-query-selector -- Sol's proof body, committed unchanged */
/// <reference lib="dom" />
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { launchChromium } from '../support/chromium.ts';
import { madeUpSession, serveApp } from './app-pages.ts';
import { load, openSide } from './capture.ts';
import { answerMadeUp } from './made-up-api.ts';
import { NATHAN, MIA } from './made-up-access.ts';
import { fetchAssets, readPacket } from './packet.ts';

// Sol OW-129 correctness, retitled by what it proves; its body is Sol's.
it('keyboard navigation keeps the active assignee visible in a long menu', async () => {
  const packet = readPacket();
  await fetchAssets();
  const browser = await launchChromium();
  const served = await serveApp();
  const out = mkdtempSync(join(tmpdir(), 'sol-ow129-'));
  try {
    const side = await openSide(browser, packet, 1480, {
      app: served.app,
      session: madeUpSession(served.app, out),
      colorScheme: 'light',
    });
    await answerMadeUp(side.context);
    await side.context.route('**/api/b/*/person/list', (route) =>
      route.fulfill({
        json: {
          ok: true,
          persons: [
            NATHAN,
            MIA,
            ...Array.from({ length: 30 }, (_, index) => ({
              personId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
              name: `Person ${String(index + 1).padStart(2, '0')}`,
            })),
          ],
        },
      }),
    );
    const page = await load(side, packet, new URL('/projects/', served.app).href);
    const trigger = page.locator('td[data-key="assignee"] .cbd__edb').first();
    await trigger.click();
    const menu = page.locator('.cbd__ed [role="listbox"]');
    await menu.waitFor();
    expect(await menu.locator('[role="option"]').count()).toBeGreaterThanOrEqual(30);
    expect(await menu.locator('.is-active').textContent()).toBe('Nathan');
    await menu.press('End');
    // Wait for React to publish the active descendant before reading its geometry.
    await expect.poll(() => menu.locator('.is-active').textContent()).toBe('Unassigned');
    const seen = await menu.evaluate((element) => {
      const activeId = element.getAttribute('aria-activedescendant');
      const active = activeId === null ? null : document.getElementById(activeId);
      if (active === null) throw new Error('the active option is missing');
      const box = element.getBoundingClientRect();
      const option = active.getBoundingClientRect();
      return {
        top: option.top,
        bottom: option.bottom,
        menuTop: box.top + element.clientTop,
        menuBottom: box.top + element.clientTop + element.clientHeight,
        scrollTop: element.scrollTop,
        label: active.textContent,
      };
    });
    expect(seen.top, JSON.stringify(seen)).toBeGreaterThanOrEqual(seen.menuTop);
    expect(seen.bottom, JSON.stringify(seen)).toBeLessThanOrEqual(seen.menuBottom);
  } finally {
    await browser.close();
    await served.close();
    rmSync(out, { recursive: true, force: true });
  }
}, 120_000);
