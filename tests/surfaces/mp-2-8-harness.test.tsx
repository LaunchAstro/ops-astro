// SPDX-License-Identifier: AGPL-3.0-only
//
// The app frame on MP-1-7's width-and-theme harness (U06, U07), measured in the
// pinned browser at 1480, 900 and 390, light and dark, each side opened by
// `openSide` with the made-up session and no API; the one read answered is the
// person's name (C23). Each test names the leg it proves: MP-2-8's named capture
// and the harness legs of MP-2-2, -4, -5, -6, -7, -9, -10, C1 and C23. Looks
// against the mockup are the look files'. A client address needs a grant the
// real entry gives only from MP-10-1, so there tests/visual/client-grant-entry.tsx
// is swapped in.

/* oxlint-disable no-await-in-loop -- one width and theme at a time, in order */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchChromium } from '../support/chromium.ts';
import { madeUpSession, serveApp } from '../visual/app-pages.ts';
import { load, openSide, shoot, type Catalogue } from '../visual/capture.ts';
import { comparePng } from '../visual/compare.ts';
import { fetchAssets, MODE, readAssets, readPacket, themesOf } from '../visual/packet.ts';
import type { Packet, Theme } from '../visual/packet.ts';

const scratch = mkdtempSync(join(tmpdir(), 'mp-2-8-'));
const WIDTHS = [1480, 900, 390] as const;
const ENTRY = fileURLToPath(new URL('../visual/client-grant-entry.tsx', import.meta.url));
const { mask } = JSON.parse(
  readFileSync(new URL('../visual/states.json', import.meta.url), 'utf8'),
) as Catalogue;

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

/** One address at one width in one theme, signed in as Mia Hart; `grant` opens every client. */
async function open(path: string, width: number, theme: Theme, grant = false): Promise<Page> {
  if (browser === undefined || served === undefined) throw new Error('the harness did not start');
  const { app } = served;
  const side = await openSide(browser, packet, width, { app, session, colorScheme: theme });
  // Registered after the side's own routes, so these run first.
  await side.context.route('**/api/b/alpha/session/person', (route) =>
    route.fulfill({ json: { ok: true, person: { name: 'Mia Hart' } } }),
  );
  if (grant) {
    await side.context.route(/\/(clients|portal)\//u, async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const response = await route.fetch();
      const body = (await response.text()).replace('/src/main.tsx', `/@fs${ENTRY}`);
      return route.fulfill({ response, body });
    });
  }
  const page = await load(side, packet, new URL(path, app).href);
  page.on('close', () => {
    side.context.close().catch(() => {});
  });
  return page;
}

const box = (page: Page, selector: string): Promise<DOMRect> =>
  page.$eval(selector, (el) => el.getBoundingClientRect().toJSON() as DOMRect);
const style = (page: Page, selector: string, name: string): Promise<string> =>
  page.$eval(selector, (el, property) => getComputedStyle(el).getPropertyValue(property), name);
const shown = async (page: Page, selector: string) =>
  (await style(page, selector, 'display')) !== 'none';
/** A token's colour as the browser resolves it, for comparing with a computed background. */
const token = (page: Page, name: string) =>
  page.evaluate((variable) => {
    const probe = document.createElement('i');
    probe.style.background = `var(${variable})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  }, name);
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);
/** The hamburger pressed, and the drawer's slide in finished. */
async function openDrawer(page: Page): Promise<void> {
  await page.click('.navtoggle');
  await page.waitForFunction(() => {
    const rail = document.querySelector('.shell[data-nav="open"] .rail');
    if (rail === null) return false;
    return (
      rail.getBoundingClientRect().left === 0 && getComputedStyle(rail).visibility === 'visible'
    );
  });
}

it('MP-2-8 harness captures: /dashboard/ at 1480, 900 and 390, light and dark; the hamburger only at 900 and below opens a min(300px, 84vw) drawer with the overlay shadow over a 40% backdrop, and Escape closes it', async () => {
  const pictures = new Map<string, Buffer>();
  await each(async (width, theme, at) => {
    const page = await open('/dashboard/', width, theme);
    const narrow = width <= 900;
    expect(await shown(page, '.navtoggle'), `hamburger at ${at}`).toBe(narrow);
    if (narrow) {
      await openDrawer(page);
      const [drawer, scrim] = [await box(page, '.rail'), '.navbackdrop'];
      expect(drawer.width, `drawer at ${at}`).toBeCloseTo(Math.min(300, width * 0.84), 0);
      expect(await style(page, '.rail', 'box-shadow'), `overlay shadow at ${at}`).not.toBe('none');
      expect(await style(page, scrim, 'background-color'), `backdrop at ${at}`).toMatch(/0\.4\)$/u);
    }
    const [shot] = await shoot(page, `frame@${width}-${theme}`, { page: 'viewport' }, mask);
    if (shot === undefined) throw new Error(`no picture at ${at}`);
    writeFileSync(join(scratch, `${shot.name}.png`), shot.png);
    pictures.set(`${width}-${theme}`, shot.png);
    expect(await sideways(page), `no sideways scroll at ${at}`).toBeLessThanOrEqual(width);
    if (narrow) {
      await page.keyboard.press('Escape');
      await page.waitForSelector('.shell:not([data-nav])');
      expect(await page.locator('.navbackdrop').count(), `Escape closes it at ${at}`).toBe(0);
    }
    await page.close();
  });
  for (const width of WIDTHS) {
    const [light, dark] = [pictures.get(`${width}-light`), pictures.get(`${width}-dark`)];
    if (light === undefined || dark === undefined) throw new Error(`no pair at ${width}`);
    const same = comparePng(`frame@${width}`, light, dark);
    expect(same.pass, `dark drawn as light at ${width}`).toBe(false);
  }
}, 600_000);

it('MP-2-2 harness leg at 1480, light and dark: a 224-wide rail of items 36 tall, the railmark on the lit item on load, sliding over 220ms to Clients', async () => {
  for (const theme of themes) {
    const page = await open('/dashboard/', 1480, theme);
    // The slide is measured with motion on; the harness draws with it reduced.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect((await box(page, '.rail')).width).toBe(224);
    const heights = await page.$$eval('.rail__item', (items) =>
      items.map((item) => item.getBoundingClientRect().height),
    );
    expect(new Set(heights)).toEqual(new Set([36]));
    const lit = async () => ({
      mark: (await box(page, '.railmark')).top,
      item: (await box(page, '.rail [data-lit]')).top,
    });
    const before = await lit();
    expect(before.mark, `railmark on the lit item, ${theme}`).toBe(before.item);
    expect((await box(page, '.railmark')).height).toBe(36);
    await page.click('.rail__item[href="/clients/"]');
    expect(await style(page, '.railmark', 'transition-duration')).toMatch(/^0\.22s/u);
    await page.waitForTimeout(40);
    const moving = await lit();
    await page.waitForTimeout(400);
    const after = await lit();
    expect(moving.mark, `railmark mid-slide, ${theme}`).not.toBe(after.item);
    expect(after.mark, `railmark on Clients, ${theme}`).toBe(after.item);
    await page.close();
  }
}, 300_000);

it('MP-2-5 harness leg: the agency strip in the dark chrome colour, search hidden at 900 and below, Back and Forward hidden at 640 and below', async () => {
  await each(async (width, theme, at) => {
    const page = await open('/dashboard/', width, theme);
    const chrome = await token(page, '--app-chrome');
    expect(await style(page, '.appbar', 'background-color'), `strip at ${at}`).toBe(chrome);
    expect(await shown(page, '.appbar__search'), `search at ${at}`).toBe(width > 900);
    expect(await shown(page, '.appbar__step'), `Back and Forward at ${at}`).toBe(width > 640);
    await page.close();
  });
}, 600_000);

it('MP-2-7 harness leg: the H1 in 24/500, and the chrome stays at the top of a long page above 900 and scrolls away at 900 and below', async () => {
  await each(async (width, theme, at) => {
    const page = await open('/dashboard/', width, theme);
    expect(await style(page, '.topbar .t-title', 'font-size'), `H1 at ${at}`).toBe('24px');
    expect(await style(page, '.topbar .t-title', 'font-weight'), `H1 at ${at}`).toBe('500');
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('.content')?.style.setProperty('min-height', '4000px');
      window.scrollTo(0, 1200);
    });
    const top = (await box(page, '.chrome')).top;
    if (width > 900) expect(top, `chrome stays at ${at}`).toBe(0);
    else expect(top, `chrome scrolls away at ${at}`).toBeLessThan(-100);
    await page.close();
  });
}, 600_000);

it("MP-2-6 harness leg: the section's tab row with the underline under the current tab, and a client's fourteen workbench tabs scroll inside the row, never widening the page at 390", async () => {
  await each(async (width, theme, at) => {
    const page = await open('/dashboard/', width, theme);
    expect(await page.locator('.tabbar__t').allTextContents()).toEqual(['Portfolio', 'Executive']);
    const tab = await box(page, '.tabbar__t[aria-current="page"]');
    const mark = await box(page, '.tabmark');
    expect(Math.round(mark.left), `underline at ${at}`).toBe(Math.round(tab.left));
    // The harness gives the bundled faces after first paint, and the underline
    // keeps the width it measured under the fallback face: within 2px.
    expect(Math.abs(mark.width - tab.width), `underline at ${at}`).toBeLessThanOrEqual(2);
    await page.close();
    const workbench = await open('/clients/acme-dental/workbench/', width, theme, true);
    expect(await workbench.locator('.tabbar__t').count()).toBe(14);
    expect(await sideways(workbench), `no sideways scroll at ${at}`).toBeLessThanOrEqual(width);
    if (width === 390) {
      expect(await workbench.locator('.tabbar').getAttribute('data-more')).toContain('end');
      expect(await workbench.locator('.tabbar__arrow').count()).toBeGreaterThan(0);
    }
    await workbench.close();
  });
}, 600_000);

it('MP-2-9 and MP-2-4 harness legs: inside a client the rail holds Back to Clients in the small primary dress over seven sections and the strip carries the client; the portal strip is teal with no search, timer or dock', async () => {
  await each(async (width, theme, at) => {
    const page = await open('/clients/acme-dental/', width, theme, true);
    if (width <= 900) await openDrawer(page);
    const back = page.locator('.rail__back');
    expect(await back.getAttribute('class'), `dress at ${at}`).toContain('btn--primary btn--sm');
    expect(await back.getAttribute('href')).toBe('/clients/');
    await expect.poll(() => back.isVisible(), { message: `back link at ${at}` }).toBe(true);
    expect(await page.locator('.rail__item').count(), `sections at ${at}`).toBe(7);
    expect(await page.locator('.clienthdr__name').textContent()).toBe('Acme Dental');
    expect(await sideways(page), `no sideways scroll at ${at}`).toBeLessThanOrEqual(width);
    await page.close();
    const portal = await open('/portal/acme-dental/', width, theme, true);
    const teal = await token(portal, '--client-brand');
    expect(await style(portal, '.appbar', 'background-color'), `teal strip at ${at}`).toBe(teal);
    expect(await portal.locator('.clienthdr__tag').textContent()).toBe('Client portal');
    const absent = ['.appbar__search', '.appbar__timer', '.dock__tab'];
    for (const selector of absent) expect(await portal.locator(selector).count(), selector).toBe(0);
    expect(await sideways(portal), `no sideways scroll at ${at}`).toBeLessThanOrEqual(width);
    await portal.close();
  });
}, 600_000);

it('C1 harness leg: Ctrl+K opens the search palette, focused and inside the viewport over the 40% scrim, at every width, and Escape closes it', async () => {
  await each(async (width, theme, at) => {
    const page = await open('/dashboard/', width, theme);
    await page.keyboard.press('Control+k');
    const palette = await box(page, '.palette');
    expect(palette.left, `palette at ${at}`).toBeGreaterThanOrEqual(0);
    expect(palette.right, `palette at ${at}`).toBeLessThanOrEqual(width);
    expect(await page.$eval('.palette__field', (el) => el === document.activeElement)).toBe(true);
    expect(await style(page, '.palette__scrim', 'background-color')).toMatch(/0\.4\)$/u);
    await page.keyboard.press('Escape');
    expect(await page.locator('.palette').count(), `Escape closes search at ${at}`).toBe(0);
    await page.close();
  });
}, 600_000);

it("C23 harness leg: the person circle round and 22 across at the strip's far right; its menu under the strip, inside the viewport, with the name, Your settings and Sign out", async () => {
  await each(async (width, theme, at) => {
    const page = await open('/dashboard/', width, theme);
    await page.waitForSelector('.who__trigger[aria-label="Mia Hart, signed in"]');
    const [circle, strip] = [await box(page, '.who__trigger .av'), await box(page, '.appbar')];
    expect([circle.width, circle.height], `circle at ${at}`).toEqual([22, 22]);
    expect(await style(page, '.who__trigger .av', 'border-radius'), `circle at ${at}`).toBe('50%');
    const inside = circle.top >= strip.top && circle.bottom <= strip.bottom;
    expect(inside, `in the strip at ${at}`).toBe(true);
    expect(strip.right - circle.right, `far right at ${at}`).toBeLessThan(30);
    await page.click('.who__trigger');
    const menu = await box(page, '.who__menu');
    expect(menu.left >= 0 && menu.right <= width, `menu inside at ${at}`).toBe(true);
    expect(menu.top, `menu under the strip at ${at}`).toBeGreaterThanOrEqual(strip.bottom - 1);
    expect(await page.locator('.who__name').textContent()).toBe('Mia Hart');
    const items = await page.locator('.who__menu [role="menuitem"]').allTextContents();
    expect(items).toEqual(['Your settings', 'Sign out']);
    await page.close();
  });
}, 600_000);

it('MP-2-10 harness leg: a reserved address (/docs/) draws the one shared Not here yet state, with no Docs in the rail and no sideways scroll', async () => {
  await each(async (width, theme, at) => {
    const page = await open('/docs/', width, theme);
    const state = '.readstate[data-outcome="placeholder"] .empty__title';
    expect(await page.locator(state).textContent()).toBe('Not here yet');
    const rail = await page.locator('.rail__item').allTextContents();
    expect(rail, `rail at ${at}`).not.toContain('Docs');
    expect(await sideways(page), `no sideways scroll at ${at}`).toBeLessThanOrEqual(width);
    await page.close();
  });
}, 600_000);
