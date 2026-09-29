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
import type { Browser, BrowserContext, BrowserContextOptions, Page, Route } from 'playwright';
import { routeRules, sourceOf } from './mockup-routes.ts';
import { fontCache, readAssets, type Packet, type Theme } from './packet.ts';

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
  /** The app-only drift mode's page (a route id), control, token and theme. */
  appDrift: { page: string; control: string; token: string; theme: string; note: string };
  states: State[];
};
export type Side = {
  context: BrowserContext;
  theme: Theme;
  external: Set<string>;
  unresolved: Set<string>;
};

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
  const blob = (file: string): Buffer | undefined => {
    const kept = blobs.get(file);
    if (kept !== undefined) return kept;
    try {
      const bytes = execFileSync(
        'git',
        ['-C', source.mockupDir, 'cat-file', 'blob', `${source.tree}:${file.slice(1)}`],
        { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
      );
      blobs.set(file, bytes);
      return bytes;
    } catch {
      return undefined;
    }
  };
  let path = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
  let bytes = blob(path);
  if (bytes === undefined) {
    // A canonical address has no file of its own: its source draws it (routes.json).
    const manifest = blob('/routes.json');
    const rules = manifest === undefined ? [] : routeRules(JSON.parse(manifest.toString('utf8')));
    const file = sourceOf(url.pathname, rules, (one) => blob(one) !== undefined);
    if (file !== undefined) [path, bytes] = [file, blob(file)];
  }
  if (bytes === undefined) {
    side.unresolved.add(url.href);
    return route.fulfill({ status: 404, body: '' });
  }
  return route.fulfill({ body: bytes, contentType: typeOf(path) });
}

/** The browser context one capture draws in: the packet's viewport at one width, in one theme. */
export function contextOptions(packet: Packet, width: number, theme: Theme): BrowserContextOptions {
  return {
    viewport: { width, height: packet.height },
    deviceScaleFactor: 1,
    // The app takes its theme from the system setting before first paint (MP-1-1).
    colorScheme: theme,
    reducedMotion: 'reduce',
    locale: 'en-AU',
    timezoneId: 'Australia/Brisbane',
    serviceWorkers: 'block',
  };
}

/**
 * A signed-in local fixture session (T4b1), given as a Playwright storage-state
 * file. The app keeps its session in `sessionStorage`, which storage state does
 * not carry, so the file's storage entries for the app's own origin are the
 * session store's contents: they are set in `sessionStorage` before the app's
 * first script runs, and never in `localStorage`. Its cookies are kept.
 */
function sessionOf(
  file: string,
  origin: string,
): { cookies: StorageState['cookies']; entries: [string, string][] } {
  const state = JSON.parse(readFileSync(file, 'utf8')) as StorageState;
  const entries = state.origins
    .filter((one) => one.origin === origin)
    .flatMap((one) => one.localStorage.map((item): [string, string] => [item.name, item.value]));
  if (entries.length === 0) {
    throw new Error(`visual: the session file holds no session for ${origin}`);
  }
  return { cookies: state.cookies, entries };
}
type StorageState = {
  cookies: Exclude<BrowserContextOptions['storageState'], string | undefined>['cookies'];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
};

/** Where one request of a side goes: bundled fonts, known externals, the side's own origin. */
function routeOne(
  route: Route,
  packet: Packet,
  source: { mockupDir: string; tree: string } | { app: URL },
  side: Side,
  blobs: Map<string, Buffer>,
): Promise<void> {
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
}

/** One side of the comparison: the mockup, or the app at a local address. */
export async function openSide(
  browser: Browser,
  packet: Packet,
  width: number,
  source:
    | { mockupDir: string; tree: string; theme?: Theme | undefined }
    | { app: URL; session?: string | undefined; colorScheme?: Theme | undefined },
): Promise<Side> {
  // Light unless the side names its theme (the app's by colour scheme, the mockup's by its key).
  const theme: Theme = ('app' in source ? source.colorScheme : source.theme) ?? 'light';
  const session =
    'app' in source && source.session !== undefined
      ? sessionOf(source.session, source.app.origin)
      : undefined;
  const context = await browser.newContext({
    ...(session === undefined ? {} : { storageState: { cookies: session.cookies, origins: [] } }),
    ...contextOptions(packet, width, theme),
  });
  const side: Side = { context, theme, external: new Set(), unresolved: new Set() };
  const blobs = new Map<string, Buffer>();
  await context.route('**/*', (route: Route) => routeOne(route, packet, source, side, blobs));
  if (session !== undefined && 'app' in source) {
    await context.addInitScript(
      ({ origin, entries }: { origin: string; entries: [string, string][] }) => {
        if (location.origin !== origin) return;
        for (const [key, value] of entries) sessionStorage.setItem(key, value);
      },
      { origin: source.app.origin, entries: session.entries },
    );
  }
  // The mockup takes its theme from its own stored key.
  if ('mockupDir' in source) {
    await context.addInitScript(
      ([key, value]: [string, Theme]) => localStorage.setItem(key, value),
      [packet.themeKey, theme] as [string, Theme],
    );
  }
  return side;
}

/** Loads a page at the fixed clock, with the bundled faces and the side's theme proved in use. */
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
  // Each capture is proved to draw in its side's theme: the mockup marks the
  // body, the app the root element, before first paint. A page that marks no
  // theme (the drift mode's made-up pages) is its caller's to prove: the
  // app-only drift mode compares it with its light drawing.
  const drawn = await page.evaluate(
    // oxlint-disable-next-line unicorn/prefer-dom-node-dataset -- null, not undefined, when unmarked: the form REV155P3C's test reads
    () => document.body.dataset['theme'] ?? document.documentElement.getAttribute('data-theme'),
  );
  if (drawn !== null && drawn !== side.theme) {
    throw new Error(`visual: ${url} drew in ${String(drawn)}, not ${side.theme}`);
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
