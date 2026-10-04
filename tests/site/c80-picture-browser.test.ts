// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 capture picture, in a real browser: headless Chromium with JavaScript
// left ON, every request intercepted and handed to the product's route. The
// page's inline script still does not run (the document's policy, not the
// browser's setting, stops it), the image on another host and the frame never
// load, and the only requests that reach the transport are the page and its
// stylesheet. The page's host does not resolve anywhere: a request that
// escaped the route would fail the load. The browser starts with the
// picture's launch arguments, so a hint the route never sees reaches nothing.
//
// Skipped, with a warning, where no Chromium is installed (CI installs none
// today); the scripted run in c80-picture.test.ts holds the route's rules there.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PICTURE_BROWSER_ARGS,
  capturePage,
  capturePicture,
  type PictureBrowser,
  type Transport,
  type TransportAnswer,
} from '../../packages/core-connectors/src/index.ts';
import { launchChromium } from '../support/chromium.ts';
import { ABOUT, PAGE, POOL, SHEET, publicResolver, site } from './c80-picture-world.ts';

const installed = existsSync(chromium.executablePath());
if (!installed)
  console.warn('C80 capture picture (browser): no Chromium installed, so nothing ran.');

let browser: Browser;
beforeAll(async () => {
  if (installed) browser = await launchChromium({ args: [...PICTURE_BROWSER_ARGS] });
}, 60_000);
afterAll(async () => {
  if (installed) await browser.close();
});

interface Opened {
  readonly context: BrowserContext;
  readonly close: () => Promise<void>;
}

const fresh = async (): Promise<Opened> => {
  const context = await browser.newContext({ javaScriptEnabled: true, serviceWorkers: 'block' });
  return { context, close: () => context.close() };
};

/** A full Chromium on a profile of its own, as a long-lived worker keeps one: hints are on. */
async function profiled(args: readonly string[]): Promise<Opened> {
  const profile = mkdtempSync(join(tmpdir(), 'c80-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    args: [...args],
    env: { ...process.env, TMPDIR: profile },
    serviceWorkers: 'block',
  });
  const close = async () => {
    try {
      await context.close();
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  };
  return { context, close };
}

interface Probe {
  ran?: string | null;
  /** The first paragraph's text colour, as the browser computed it. */
  colour?: string;
}

/** The worker's browser port, as a real one: every request goes to the route. */
function chromiumPort(probe: Probe, open = fresh): PictureBrowser {
  return async (url, route) => {
    const { context, close } = await open();
    try {
      const page = await context.newPage();
      await page.route('**/*', async (intercepted) => {
        const request = intercepted.request();
        const answer = await route({
          url: request.url(),
          kind: request.resourceType(),
          mainFrame: request.isNavigationRequest() && request.frame() === page.mainFrame(),
        });
        await (answer === null
          ? intercepted.abort()
          : intercepted.fulfill({
              status: answer.status,
              headers: answer.headers,
              body: answer.body,
            }));
      });
      await page.goto(url, { waitUntil: 'load' });
      probe.ran = await page.getAttribute('html', 'data-ran');
      probe.colour = await page
        .locator('p')
        .first()
        .evaluate((p) => getComputedStyle(p).color);
      return new Uint8Array(await page.screenshot({ fullPage: true }));
    } finally {
      await close();
    }
  };
}

describe.skipIf(!installed)('C80 capture picture, in a real browser', () => {
  it('renders through the fence alone, and the page runs no script', async () => {
    const transport = site();
    const probe: Probe = {};
    const picture = await capturePicture(
      ABOUT,
      { pool: POOL, resolve: publicResolver, transport },
      chromiumPort(probe),
    );
    if (!picture.ok) throw new Error(`the picture failed: ${picture.code}`);
    expect(Array.from(picture.value.png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(picture.value.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(probe.ran).toBeNull();
    expect(transport.seen.toSorted()).toEqual([ABOUT, SHEET].toSorted());
  }, 60_000);
});

/** A local socket that counts every connection made to it. */
async function listening() {
  const connections: string[] = [];
  const server = createServer((socket) => {
    connections.push(String(socket.remoteAddress));
    socket.destroy();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return { connections, server, port: (server.address() as AddressInfo).port };
}

describe.skipIf(!installed)('C80 capture picture, in a real browser, no network of its own', () => {
  // Security review of P25, low 5: resource hints open connections no route ever sees.
  it('makes no connection for a preconnect or DNS prefetch the page asks for', async () => {
    const { connections, server, port } = await listening();
    const hints = `<meta http-equiv="x-dns-prefetch-control" content="on">
<link rel="preconnect" href="http://127.0.0.1:${port}">
<link rel="preconnect" href="https://127.0.0.1:${port}" crossorigin>
<link rel="preconnect" href="http://localhost:${port}">
<link rel="dns-prefetch" href="//localhost:${port}">`;
    const served = site();
    const transport: Transport = (request) =>
      request.url.href === ABOUT
        ? Promise.resolve({
            kind: 'answer',
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: new TextEncoder().encode(PAGE.replace('<head>', `<head>${hints}`)),
          })
        : served(request);
    try {
      const options = { pool: POOL, resolve: publicResolver, transport };
      const picture = await capturePicture(
        ABOUT,
        options,
        chromiumPort({}, () => profiled(PICTURE_BROWSER_ARGS)),
      );
      expect(picture.ok).toBe(true);
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
      expect(connections).toEqual([]);
    } finally {
      server.close();
    }
  }, 60_000);
});

// Sol's first review of PR 364, three correctness findings: the picture must load the sheets the
// page observation read. Each site below serves a red sheet where the observation resolves the
// page's addresses and a blue one where a browser that lost the final address or the base would.
const RED = 'rgb(255, 0, 0)';
const MOVED = 'https://www.example.com/new/about';
const at = (path: string) => `https://www.example.com${path}`;
const ok = (type: string, body: string): TransportAnswer => ({
  kind: 'answer',
  status: 200,
  headers: { 'content-type': type },
  body: new TextEncoder().encode(body),
});
const moved = (path: string): TransportAnswer => ({
  kind: 'answer',
  status: 302,
  headers: { location: path },
  body: new Uint8Array(),
});
const page = (head: string) => ok('text/html; charset=utf-8', `${head}<p>Hello</p>`);
const sheet = (colour: string) => ok('text/css', `p { color: ${colour}; }`);

/** The observation and the picture of ABOUT on one site, and the colour the picture showed. */
async function both(pages: Record<string, TransportAnswer>) {
  const transport: Transport = (request) =>
    Promise.resolve(pages[request.url.href] ?? ok('text/plain', 'missing'));
  const pool = { ...POOL, agencyPages: [ABOUT, MOVED] };
  const options = { pool, resolve: publicResolver, transport };
  const observed = await capturePage(ABOUT, options);
  const probe: Probe = {};
  const picture = await capturePicture(ABOUT, options, chromiumPort(probe));
  return { observed, shown: picture.ok ? probe.colour : 'refused' };
}

describe.skipIf(!installed)('C80 capture picture, in a real browser, Sol R1', () => {
  it('Sol proof, criterion correctness: picture retains the final document URL after a fenced redirect', async () => {
    const { observed, shown } = await both({
      [ABOUT]: moved('/new/about'),
      [MOVED]: page('<link rel=stylesheet href=site.css>'),
      [at('/new/site.css')]: sheet('red'),
      [at('/site.css')]: sheet('blue'),
    });
    expect(observed.ok && Object.keys(observed.value.stylesheets)).toEqual([at('/new/site.css')]);
    expect([RED, 'refused']).toContain(shown);
  }, 60_000);

  it('Sol proof, criterion correctness: picture retains the final stylesheet URL for relative imports', async () => {
    const { observed, shown } = await both({
      [ABOUT]: page('<link rel=stylesheet href=/_astro/site.css>'),
      [at('/_astro/site.css')]: moved('/_astro/v2/site.css'),
      [at('/_astro/v2/site.css')]: ok('text/css', '@import "theme.css";'),
      [at('/_astro/v2/theme.css')]: sheet('red'),
      [at('/_astro/theme.css')]: sheet('blue'),
    });
    expect(observed.ok && Object.keys(observed.value.stylesheets)).toEqual([
      at('/_astro/site.css'),
      at('/_astro/v2/theme.css'),
    ]);
    expect([RED, 'refused']).toContain(shown);
  }, 60_000);

  it('Sol proof, criterion correctness: picture honours a same-host base URL or refuses the capture', async () => {
    const { observed, shown } = await both({
      [ABOUT]: page('<base href=/assets/><link rel=stylesheet href=site.css>'),
      [at('/assets/site.css')]: sheet('red'),
      [at('/site.css')]: sheet('blue'),
    });
    expect(observed.ok && Object.keys(observed.value.stylesheets)).toEqual([
      at('/assets/site.css'),
    ]);
    expect([RED, 'refused']).toContain(shown);
  }, 60_000);
});

// The eleventh security re-bind, L1: the document's policy (style-src 'self') blocked a sheet on
// another host before any request reached the route, so the picture succeeded without a sheet the
// page links, one the observation refuses. The review's case, a page redirected to another host
// linking the first host's sheet, is refused already: Chromium hands a cross-site redirect to no
// route, so the browser meets its proxy and the load fails.
describe.skipIf(!installed)('C80 capture picture, in a real browser, the eleventh re-bind', () => {
  it('is refused where a sheet the page links is refused, not shown without it', async () => {
    const elsewhere = 'https://studio.example.org/site.css';
    const { observed, shown } = await both({
      [ABOUT]: page(`<link rel=stylesheet href=${elsewhere}>`),
      [elsewhere]: sheet('red'),
    });
    expect(observed.ok).toBe(false);
    expect(shown).toBe('refused');
  }, 60_000);
});
