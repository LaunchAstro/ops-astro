// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
//
// Capturing one side of the comparison in the pinned renderer.
//
// The network is closed. Every request is answered by route interception:
// the mockup's own files from the pinned git tree, its two external addresses
// from the packet's list (the fonts from the bundled bytes, the refused icon
// set as an empty stylesheet), the app from its local address only, and
// anything else is aborted and reported as unresolved. The same bundled faces
// are given to the app, and each capture asserts the families resolved to
// them rather than to a font the machine happens to have installed.

/* oxlint-disable no-await-in-loop -- regions are captured one at a time, in order:
   a comparison is only deterministic while one thing draws */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page, Route } from 'playwright';
import { fontCache, readAssets, type Packet } from './packet.ts';

export type State = {
  id: string;
  note?: string;
  mockup: string | null;
  regions?: Record<string, string>;
  hide?: string[];
  open?: string;
  app?: string;
  appPath?: string;
  appRegions?: Record<string, string>;
  reason?: string;
};
export type Catalogue = {
  screenshots: string;
  mask: string[];
  drift: { state: string; control: string; token: string };
  states: State[];
};
export type Side = { context: BrowserContext; external: Set<string>; unresolved: Set<string> };

export const MOCKUP_ORIGIN = 'http://mockup.invalid';
const ASSET_ORIGIN = 'http://assets.invalid';
const TYPES: Record<string, string> = {
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  ttf: 'font/ttf',
};
const typeOf = (path: string): string =>
  TYPES[path.split('.').pop() ?? ''] ?? 'application/octet-stream';

/** The @font-face rules for every bundled font; no local() source, so no system face. */
export function fontCss(): string {
  return readAssets()
    .assets.filter((a) => a.kind === 'font' && a.file !== undefined)
    .map(
      (a) =>
        `@font-face{font-family:"${a.name}";font-style:normal;font-weight:${String(a.weight)};` +
        `font-display:block;src:url("${ASSET_ORIGIN}/${String(a.file)}") format("truetype")}`,
    )
    .join('\n');
}

/** The mockup's bytes from the pinned tree, never from a working copy. */
function serveMockup(
  route: Route,
  url: URL,
  source: { mockupDir: string; tree: string },
  blobs: Map<string, Buffer>,
  side: Side,
): Promise<void> {
  const path = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
  let bytes = blobs.get(path);
  if (bytes === undefined) {
    try {
      bytes = execFileSync(
        'git',
        ['-C', source.mockupDir, 'cat-file', 'blob', `${source.tree}:${path.slice(1)}`],
        { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
      );
    } catch {
      side.unresolved.add(url.href);
      return route.fulfill({ status: 404, body: '' });
    }
    blobs.set(path, bytes);
  }
  return route.fulfill({ body: bytes, contentType: typeOf(path) });
}

/** One side of the comparison: the mockup, or the app at a local address. */
export async function openSide(
  browser: Browser,
  packet: Packet,
  width: number,
  source: { mockupDir: string; tree: string } | { app: URL; session?: string | undefined },
): Promise<Side> {
  const context = await browser.newContext({
    // A signed-in local fixture session (T4b1), as Playwright storage state.
    ...('app' in source && source.session !== undefined ? { storageState: source.session } : {}),
    viewport: { width, height: packet.height },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'en-AU',
    timezoneId: 'Australia/Brisbane',
    serviceWorkers: 'block',
  });
  const side: Side = { context, external: new Set(), unresolved: new Set() };
  const blobs = new Map<string, Buffer>();
  await context.route('**/*', (route: Route) => {
    const url = new URL(route.request().url());
    const known = packet.external[url.href];
    if (url.origin === ASSET_ORIGIN) {
      const bytes = readFileSync(`${fontCache}/${url.pathname.slice(1)}`);
      return route.fulfill({ body: bytes, contentType: typeOf(url.pathname) });
    }
    if (known !== undefined) {
      side.external.add(url.href);
      const body = known === 'bundled fonts' ? fontCss() : `/* ${known} */`;
      return route.fulfill({ body, contentType: 'text/css' });
    }
    if ('app' in source && url.origin === source.app.origin) return route.continue();
    if ('mockupDir' in source && url.origin === MOCKUP_ORIGIN) {
      return serveMockup(route, url, source, blobs, side);
    }
    side.unresolved.add(url.href);
    return route.abort('blockedbyclient');
  });
  if ('mockupDir' in source) {
    await context.addInitScript(
      (key: string) => localStorage.setItem(key, 'light'),
      packet.themeKey,
    );
  }
  return side;
}

/** Loads a page at the fixed clock, with the bundled faces proved in use. */
export async function load(
  side: Side,
  packet: Packet,
  url: string,
  prep: { hide?: string[] | undefined; open?: string | undefined } = {},
): Promise<Page> {
  const hide = prep.hide ?? [];
  const page = await side.context.newPage();
  await page.clock.setFixedTime(new Date(packet.clock));
  await page.goto(url, { waitUntil: 'load' });
  await page.addStyleTag({ content: fontCss() });
  if (hide.length > 0)
    await page.addStyleTag({ content: `${hide.join(',')}{display:none!important}` });
  const families = readAssets()
    .assets.filter((a) => a.kind === 'font' && a.file !== undefined)
    .map((a) => a.name);
  const missing = await page.evaluate(async (names: string[]) => {
    await Promise.all(names.map((n) => document.fonts.load(`16px "${n}"`)));
    await document.fonts.ready;
    const loaded = [...document.fonts].filter((f) => f.status === 'loaded');
    return names.filter((n) => !loaded.some((f) => f.family.replaceAll('"', '') === n));
  }, families);
  if (missing.length > 0) {
    throw new Error(`visual: ${url} did not resolve ${missing.join(', ')} to a bundled face`);
  }
  // A state behind a tab or a disclosure is opened the way a person would.
  if (prep.open !== undefined) await page.locator(prep.open).first().click();
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  return page;
}

/** One PNG per region, content-masked; a region missing from the page refuses. */
export async function shoot(
  page: Page,
  name: string,
  regions: Record<string, string>,
  mask: string[],
): Promise<{ name: string; png: Buffer }[]> {
  const options = {
    animations: 'disabled' as const,
    caret: 'hide' as const,
    scale: 'css' as const,
    mask: mask.map((m) => page.locator(m)),
    maskColor: '#FF00FF',
  };
  const shots = [];
  for (const [region, selector] of Object.entries(regions)) {
    const capture = `${name}#${region}`;
    if (selector === 'viewport') {
      shots.push({ name: capture, png: await page.screenshot(options) });
      continue;
    }
    const target = page.locator(selector).filter({ visible: true }).first();
    if ((await target.count()) === 0) {
      throw new Error(`visual: ${capture}: region ${selector} is not on the page`);
    }
    shots.push({ name: capture, png: await target.screenshot(options) });
  }
  return shots;
}
