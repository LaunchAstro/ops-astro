// SPDX-License-Identifier: AGPL-3.0-only
//
// The world for the live-view proofs: the product (the fixture beside this
// file, served by Vite with the real embed route), the review's site, whose
// pages load the embed through the onboarding snippet and send its
// frame-ancestors header, and a hostile second origin. All three are served
// through the browser context's routes, so nothing listens beyond Vite.

import { expect } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { Hono } from 'hono';
import { mountReviewEmbed } from '../../apps/api/review-embed.ts';
import {
  LIVE_PROTOCOL,
  REVIEW_EMBED_PATH,
  reviewEmbedSnippet,
} from '../../packages/core-wire/src/index.ts';
import { launchChromium } from '../support/chromium.ts';

export const PRODUCT = 'https://product.test';
export const SITE = 'https://site.test';
export const HOSTILE = 'https://hostile.test';
export const CANARY = 'CANARY-c35x-7f3e9a';
export const LINE = "Live view isn't set up for this site";
const SNIPPET = reviewEmbedSnippet(PRODUCT);
const HELLO = JSON.stringify(LIVE_PROTOCOL.hello);
const VERSION = String(LIVE_PROTOCOL.version);
const FRAMING = SNIPPET.header.replace(/^[^:]+:\s*/u, '');

/** Remember the nonce a ping carried, as the site sees it (test pages only). */
const NOTE_PING = `<script>addEventListener('message', (e) => {
  if (e.data && typeof e.data.nonce === 'string') document.body.dataset.nonce = e.data.nonce;
});</script>`;

const SITE_PAGES: Record<string, { readonly body: string; readonly framing?: string }> = {
  '/embed': { body: `<p>${CANARY}</p>${SNIPPET.script}${NOTE_PING}` },
  '/embed-then-away': {
    body: `<p>${CANARY}</p>${SNIPPET.script}<script>setTimeout(() => {
      location.href = '${HOSTILE}/away';
    }, 1000);</script>`,
  },
  '/embed-then-embed': {
    body: `<p>${CANARY}</p>${SNIPPET.script}<script>setTimeout(() => {
      location.href = '${SITE}/embed';
    }, 1000);</script>`,
  },
  '/embed-then-endless': {
    body: `<p>${CANARY}</p>${SNIPPET.script}<script>setTimeout(() => {
      location.href = '${HOSTILE}/endless';
    }, 1000);</script>`,
  },
  '/bare': { body: `<p>${CANARY}</p>` },
  '/refused': { body: `<p>${CANARY}</p>${SNIPPET.script}`, framing: "frame-ancestors 'none'" },
  '/late': {
    body: `<p>${CANARY}</p>${NOTE_PING}<script>setTimeout(() => {
      parent.postMessage({ type: ${HELLO}, version: ${VERSION}, nonce: document.body.dataset.nonce }, '*');
      document.body.dataset.sent = '1';
    }, 3500);</script>`,
  },
  '/origin-forger': {
    body: `<iframe src="${HOSTILE}/forge"></iframe><script>addEventListener('message', (e) => {
      if (e.data && typeof e.data.nonce === 'string') frames[0].postMessage(e.data.nonce, '${HOSTILE}');
    });</script>`,
  },
  '/relay': {
    body: `<script>const c = new BroadcastChannel('relay'); addEventListener('message', (e) => {
      if (e.data && typeof e.data.nonce === 'string') c.postMessage(e.data.nonce);
    });</script>`,
  },
  '/sibling': {
    body: `<script>new BroadcastChannel('relay').onmessage = (e) => {
      parent.postMessage({ type: ${HELLO}, version: ${VERSION}, nonce: e.data }, '*');
      document.body.dataset.sent = '1';
    };</script>`,
  },
  '/malformed': {
    body: `<script>addEventListener('message', (e) => {
      const nonce = e.data && e.data.nonce;
      if (typeof nonce !== 'string' || document.body.dataset.sent) return;
      for (const data of [
        { type: ${HELLO}, version: ${VERSION}, nonce: nonce + 'x' },
        { type: ${HELLO}, version: ${VERSION}, nonce, extra: '<img src=x onerror=alert(1)>' },
        { type: ${HELLO}, version: 2, nonce },
        { type: ${HELLO}, version: ${VERSION}, nonce: 'x'.repeat(100000) },
        JSON.stringify({ type: ${HELLO}, version: ${VERSION}, nonce }),
        [${HELLO}, ${VERSION}, nonce],
        null,
      ]) parent.postMessage(data, '*');
      document.body.dataset.sent = '1';
    });</script>`,
  },
};

const HOSTILE_PAGES: Record<string, string> = {
  '/away': `<p>${CANARY}</p>`,
  // Its image never answers, so the frame's load never fires.
  '/endless': `<p>${CANARY}</p><img src="${HOSTILE}/hang" alt="">`,
  '/forge': `<script>addEventListener('message', (e) => {
    top.postMessage({ type: ${HELLO}, version: ${VERSION}, nonce: e.data }, '*');
    document.body.dataset.sent = '1';
  });</script>`,
  '/attack': `<p>${CANARY}</p>${SNIPPET.script}<script>setTimeout(() => {
    const result = {};
    try { top.location.href = '${HOSTILE}/took'; result.top = 'tried'; } catch { result.top = 'threw'; }
    try { result.popup = window.open('${HOSTILE}/popup') === null ? 'blocked' : 'opened'; } catch { result.popup = 'threw'; }
    const a = document.createElement('a'); a.href = 'data:text/plain,${CANARY}'; a.download = 'x.txt';
    document.body.append(a); a.click();
    const policy = document.permissionsPolicy ?? document.featurePolicy;
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment']) {
      result[feature] = policy.allowsFeature(feature);
    }
    parent.postMessage({ type: ${HELLO}, version: ${VERSION}, nonce: 'forged-${CANARY}' }, '*');
    parent.postMessage('<script>alert(1)</' + 'script>${CANARY}', '*');
    document.body.dataset.result = JSON.stringify(result);
  }, 300);</script>`,
};

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let local = '';

/** The embed route, as the API mounts it, inside the proof's Vite server. */
function embedRoute(): Plugin {
  const embed = new Hono();
  mountReviewEmbed(embed);
  return {
    name: 'review-embed-route',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== REVIEW_EMBED_PATH) {
          next();
          return;
        }
        void (async () => {
          const answer = await embed.request(REVIEW_EMBED_PATH);
          response.statusCode = answer.status;
          answer.headers.forEach((value, name) => response.setHeader(name, value));
          response.end(await answer.text());
        })();
      });
    },
  };
}

export async function startWorld(): Promise<void> {
  server = await createServer({
    configFile: false,
    plugins: [react(), embedRoute()],
    server: { host: '0.0.0.0', port: 0, hmr: false, allowedHosts: ['host.docker.internal'] },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (typeof address !== 'object' || address === null) throw new Error('no proof server');
  local = `http://${process.env['SOL_BROWSER_HOST'] ?? '127.0.0.1'}:${address.port}`;
  const remote = process.env['SOL_BROWSER_WS'];
  browser = remote === undefined ? await launchChromium() : await chromium.connect(remote);
}

export async function stopWorld(): Promise<void> {
  await browser?.close();
  await server?.close();
}

export interface Watched {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Everything the product's page wrote to the console, or threw. */
  readonly productSaid: string[];
  /** The product's errors and warnings, bar the proof server's own dev client. */
  readonly productErred: string[];
  /** Every request the product's own page made. */
  readonly productAsked: string[];
  readonly popups: number[];
  readonly downloads: number[];
}

const html = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

async function routeOrigins(context: BrowserContext): Promise<void> {
  await context.route(`${PRODUCT}/**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${local}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  await context.route(`${SITE}/**`, async (route) => {
    const found = SITE_PAGES[new URL(route.request().url()).pathname];
    await route.fulfill(
      found === undefined
        ? { status: 404, body: '' }
        : {
            contentType: 'text/html',
            headers: { 'content-security-policy': found.framing ?? FRAMING },
            body: html(found.body),
          },
    );
  });
  await context.route(`${HOSTILE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/hang') return;
    const found = HOSTILE_PAGES[path];
    await route.fulfill(
      found === undefined
        ? { status: 404, body: '' }
        : { contentType: 'text/html', body: html(found) },
    );
  });
}

function watch(context: BrowserContext, page: Page): Watched {
  const watched: Watched = {
    context,
    page,
    productSaid: [],
    productErred: [],
    productAsked: [],
    popups: [],
    downloads: [],
  };
  page.on('console', (message) => {
    const from = message.location().url;
    if (!from.startsWith(PRODUCT)) return;
    watched.productSaid.push(message.text());
    const loud = message.type() === 'error' || message.type() === 'warning';
    if (loud && !from.startsWith(`${PRODUCT}/@vite/`)) watched.productErred.push(message.text());
  });
  page.on('pageerror', (error) => {
    watched.productSaid.push(`${error.message}\n${error.stack}`);
    watched.productErred.push(error.message);
  });
  page.on('request', (request) => {
    if (request.frame() === page.mainFrame()) watched.productAsked.push(request.url());
  });
  page.on('popup', () => watched.popups.push(1));
  page.on('download', () => watched.downloads.push(1));
  return watched;
}

/** The live view framing `search.page`, in a fresh context, watched from the start. */
export async function open(search: Record<string, string>): Promise<Watched> {
  if (browser === undefined) throw new Error('the world is not started');
  const context = await browser.newContext();
  await routeOrigins(context);
  const page = await context.newPage();
  const watched = watch(context, page);
  await page.goto(`${PRODUCT}/tests/browser/c35-x-live-view.html?${new URLSearchParams(search)}`);
  await page.waitForSelector('[data-live-view]');
  return watched;
}

/** Record every phase the live view takes from now on; read them with `phasesSeen`. */
export async function tracePhases(page: Page): Promise<void> {
  await page.evaluate(() => {
    const view = document.querySelector<HTMLElement>('[data-live-view]');
    if (view === null) throw new Error('no live view');
    const seen = [view.dataset['liveView'] ?? ''];
    Object.assign(window, { phasesSeen: seen });
    new MutationObserver(() => {
      const now = view.dataset['liveView'] ?? '';
      if (seen.at(-1) !== now) seen.push(now);
    }).observe(view, { attributes: true, attributeFilter: ['data-live-view'] });
  });
}

/** The phases since `tracePhases`, from the first hello on (the first wait may be over by then). */
export async function phasesSeen(page: Page): Promise<readonly string[]> {
  const seen = await page.evaluate(
    () => (window as unknown as { phasesSeen: string[] }).phasesSeen,
  );
  return seen[0] === 'waiting' ? seen.slice(1) : seen;
}

export const phase = async (page: Page): Promise<string | null> =>
  await page.locator('[data-live-view]').getAttribute('data-live-view');

export function frameAt(page: Page, path: string, origin: string = SITE): Frame {
  const found = page.frames().find((frame) => frame.url() === `${origin}${path}`);
  if (found === undefined) throw new Error(`no frame at ${origin}${path}`);
  return found;
}

/** The mark a relaying or forging page sets once its message is sent. */
export const sent = async (frame: Frame): Promise<string | undefined> =>
  await frame.evaluate(() => document.body.dataset['sent']);

/** No product word, request or rendered text carries the framed page's content. */
export function expectNoCanary(watched: Watched, words: string): void {
  for (const said of watched.productSaid) expect(said).not.toContain(CANARY);
  for (const asked of watched.productAsked) {
    expect(asked).not.toContain(CANARY);
    expect(new URL(asked).origin).toBe(PRODUCT);
  }
  expect(words).not.toContain(CANARY);
}
