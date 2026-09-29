// SPDX-License-Identifier: AGPL-3.0-only
//
// The app frame measured in a real browser (U06): what jsdom cannot lay out.
// It serves the real web application with its own Vite config on a free port,
// holds every API call unanswered so no record is read or needed, and measures
// at 1480, 900 and 390 in light and dark:
//
// - MP-2-2 items 36 tall in a 224-wide rail; the railmark on the lit item,
//   sliding over 220ms after a rail click (Dashboard, then Clients).
// - MP-2-8 the hamburger only at 900 and below; the drawer min(300px, 84vw)
//   over a 40% backdrop; Escape closes it.
// - MP-2-7 the chrome stays at the top when a long page scrolls at 901 and
//   above, and scrolls away at 900 and below.
// - MP-2-6 no page wider than the viewport at 390.
//
// Screenshots go to SHOT_DIR (default `.local/evidence/app-frame`). Exit 1 on
// any failed line. The client workspace cannot be opened in the real app until
// client records and grants exist (MP-10-1), so its looks wait for them.
//
//   node tests/browser/app-frame.mjs

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../..', import.meta.url));
const SHOTS = process.env.SHOT_DIR ?? `${root}.local/evidence/app-frame`;
mkdirSync(SHOTS, { recursive: true });

const { createServer } = createRequire(`${root}apps/web/package.json`)('vite');
const server = await createServer({
  configFile: `${root}apps/web/vite.config.ts`,
  server: { port: 0, strictPort: false },
  logLevel: 'error',
});
await server.listen();
const address = server.httpServer?.address();
const WEB = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;

const results = [];
const check = (line, ok, detail = '') => {
  results.push({ line, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${line}${detail === '' ? '' : ` (${detail})`}\n`);
};

const SESSION = JSON.stringify({ token: 'held', businessKey: 'alpha', email: 'mia@alpha.local' });
const browser = await chromium.launch();
try {
  for (const theme of ['light', 'dark']) {
    for (const width of [1480, 900, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(
        ([session, chosen]) => {
          sessionStorage.setItem('ops-astro.session', session);
          document.documentElement.setAttribute('data-theme-preference', chosen);
        },
        [SESSION, theme],
      );
      const page = await context.newPage();
      await page.route('**/api/**', () => {
        /* held: nothing is read */
      });
      const at = `${width} ${theme}`;
      await page.goto(`${WEB}/dashboard/`);
      await page.waitForSelector('.shell');
      await page.screenshot({ path: `${SHOTS}/dashboard-${width}-${theme}.png` });

      const narrow = width <= 900;
      const toggle = await page.$eval('.navtoggle', (el) => getComputedStyle(el).display);
      check(`MP-2-8 hamburger only at 900 and below, ${at}`, narrow ? toggle !== 'none' : toggle === 'none', toggle);

      if (!narrow) {
        const rail = await page.$eval('.rail', (el) => el.getBoundingClientRect().width);
        const heights = await page.$$eval('.rail__item', (items) =>
          items.map((item) => item.getBoundingClientRect().height),
        );
        check(`MP-2-2 224-wide rail, ${at}`, rail === 224, `${rail}`);
        check(`MP-2-2 items 36 tall, ${at}`, heights.every((h) => h === 36), heights.join(','));

        const lit = async () =>
          page.evaluate(() => {
            const mark = document.querySelector('.railmark').getBoundingClientRect();
            const item = document.querySelector('.rail [data-lit]').getBoundingClientRect();
            return { mark: mark.top, item: item.top, height: mark.height };
          });
        const before = await lit();
        check(`MP-2-2 railmark on the lit item on load, ${at}`, before.mark === before.item && before.height === 36);
        await page.click('.rail__item[href="/clients/"]');
        const duration = await page.$eval('.railmark', (el) => getComputedStyle(el).transitionDuration);
        await page.waitForTimeout(40);
        const moving = await lit();
        await page.waitForTimeout(400);
        const after = await lit();
        check(`MP-2-2 railmark slides over 220ms, ${at}`, duration.startsWith('0.22s'), duration);
        check(
          `MP-2-2 railmark mid-slide then on Clients, ${at}`,
          moving.mark !== after.item && after.mark === after.item,
          `${moving.mark} -> ${after.mark} (item ${after.item})`,
        );
        await page.goto(`${WEB}/dashboard/`);
        await page.waitForSelector('.shell');
      }

      // Sticky above 900, scrolling away at 900 and below, on a long page.
      await page.evaluate(() => {
        document.querySelector('.content').style.minHeight = '4000px';
      });
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(150);
      const chromeTop = await page.$eval('.chrome', (el) => el.getBoundingClientRect().top);
      check(
        `MP-2-7 chrome ${narrow ? 'scrolls away' : 'stays at the top'}, ${at}`,
        narrow ? chromeTop < -100 : chromeTop === 0,
        `${chromeTop}`,
      );
      await page.evaluate(() => window.scrollTo(0, 0));

      const wide = await page.evaluate(() => document.documentElement.scrollWidth);
      check(`MP-2-6 nothing wider than the viewport, ${at}`, wide <= width, `${wide}`);

      if (narrow) {
        await page.click('.navtoggle');
        await page.waitForTimeout(300);
        const drawer = await page.$eval('.rail', (el) => el.getBoundingClientRect().width);
        const want = Math.min(300, width * 0.84);
        check(`MP-2-8 drawer min(300px, 84vw), ${at}`, Math.abs(drawer - want) < 1, `${drawer}`);
        const scrim = await page.$eval('.navbackdrop', (el) => getComputedStyle(el).backgroundColor);
        check(`MP-2-8 40% backdrop, ${at}`, /0\.4\)$/u.test(scrim), scrim);
        await page.screenshot({ path: `${SHOTS}/drawer-${width}-${theme}.png` });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        const open = await page.$eval('.shell', (el) => el.getAttribute('data-nav'));
        check(`MP-2-8 Escape closes it, ${at}`, open === null);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
const failed = results.filter((each) => !each.ok);
process.stdout.write(`${results.length - failed.length} of ${results.length} lines hold\n`);
process.exit(failed.length === 0 ? 0 : 1);
