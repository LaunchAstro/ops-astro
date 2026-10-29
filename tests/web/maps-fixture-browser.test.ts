// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop -- capture one viewport at a time */
import { mkdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { withSignedInApp, eachBuiltPage } from '../visual/app-pages.ts';
import { answerMadeUp } from '../visual/made-up-api.ts';
import { WAYFINDER_READS } from '../visual/made-up-wayfinder.ts';

it('the Maps fixture renders at 1480, 900 and 390 in light and dark and its row opens the map', async () => {
  const out = '.local/maps-s1/browser-fixtures';
  mkdirSync(out, { recursive: true });
  await withSignedInApp(async (at) => {
    const shots = await eachBuiltPage(
      {
        ...at,
        widths: [1480, 900, 390],
        themes: ['light', 'dark'],
        pages: ['agency:maps'],
        route: async ({ signedIn }) => {
          await answerMadeUp(signedIn.context);
        },
      },
      async ({ page, width, theme }) => {
        const map = WAYFINDER_READS['map.list'].maps[0];
        expect(map).toBeDefined();
        const row = page.locator('section[aria-label="Maps"] a').first();
        await row.waitFor({ state: 'visible' });
        expect(await row.textContent()).toBe(map?.title);
        expect(await row.getAttribute('href')).toBe('/map/T-40');
        expect(await page.locator('.rail [data-lit]').textContent()).toContain('Tasks');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({ path: `${out}/maps-${width}-${theme}.png` });
        await row.click();
        await page.locator('[data-map-section="destination"]').waitFor({ state: 'visible' });
        expect(new URL(page.url()).pathname).toBe('/map/T-40');
        return `${width}-${theme}`;
      },
    );
    expect(shots).toHaveLength(6);
  });
}, 120_000);
