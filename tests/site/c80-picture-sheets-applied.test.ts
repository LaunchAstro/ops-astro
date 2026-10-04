// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import {
  PICTURE_BROWSER_ARGS,
  capturePage,
  capturePicture,
  type CaptureOptions,
  type PictureBrowser,
  type TransportAnswer,
} from '../../packages/core-connectors/src/index.ts';
import { launchChromium } from '../support/chromium.ts';

const PAGE = 'https://www.example.com/about';
const FINAL = 'https://www.example.com/assets/index.html';
const SHEET = 'https://www.example.com/site.css';
const RED = 'rgb(255, 0, 0)';

function answer(body: string, type: string): TransportAnswer {
  return {
    kind: 'answer',
    status: 200,
    headers: { 'content-type': type },
    body: new TextEncoder().encode(body),
  };
}

function world(html: string, redirect = false): CaptureOptions {
  return {
    pool: { agencyPages: [PAGE, FINAL], otherPages: [], closedPoolReviews: [] },
    resolve: () => Promise.resolve(['93.184.215.14']),
    transport: (request) => {
      if (redirect && request.url.href === PAGE)
        return Promise.resolve({
          kind: 'answer',
          status: 302,
          headers: { location: FINAL },
          body: new Uint8Array(),
        });
      return Promise.resolve(
        request.url.pathname.endsWith('.css')
          ? answer('p{color:red}', 'text/css')
          : answer(html, 'text/html; charset=utf-8'),
      );
    },
  };
}

interface Probe {
  colour?: string;
  url?: string;
  error?: string;
  requests: string[];
}

function browserPort(probe: Probe): PictureBrowser {
  return async (url, route) => {
    const browser = await launchChromium({ args: [...PICTURE_BROWSER_ARGS] });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      await page.route('**/*', async (intercepted) => {
        const request = intercepted.request();
        probe.requests.push(request.url());
        const response = await route({
          url: request.url(),
          kind: request.resourceType(),
          mainFrame: request.isNavigationRequest() && request.frame() === page.mainFrame(),
        });
        if (response === null) await intercepted.abort();
        else await intercepted.fulfill(response);
      });
      await page.goto(url, { waitUntil: 'load' });
      probe.url = page.url();
      probe.colour = await page.locator('p').evaluate((node) => getComputedStyle(node).color);
      return new Uint8Array(await page.screenshot());
    } catch (error) {
      probe.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await browser.close();
    }
  };
}

it('the claimed catalogued document redirect produces a picture at its final URL', async () => {
  const options = world('<link rel=stylesheet href=site.css><p>Hello</p>', true);
  const observed = await capturePage(PAGE, options);
  expect(observed).toMatchObject({ ok: true, value: { url: FINAL } });
  const probe: Probe = { requests: [] };
  const picture = await capturePicture(PAGE, options, browserPort(probe));
  expect(picture.ok, JSON.stringify(probe)).toBe(true);
  expect(probe.url).toBe(FINAL);
  expect(probe.colour).toBe(RED);
}, 30_000);

it('markup CSP cannot silently remove an observed stylesheet from a successful picture', async () => {
  const options = world(
    '<meta http-equiv=Content-Security-Policy content="style-src \'none\'">' +
      '<link rel=stylesheet href=/site.css><p>Hello</p>',
  );
  const observed = await capturePage(PAGE, options);
  expect(observed.ok && Object.keys(observed.value.stylesheets)).toEqual([SHEET]);
  const probe: Probe = { requests: [] };
  const picture = await capturePicture(PAGE, options, browserPort(probe));
  expect(!picture.ok || probe.colour === RED, JSON.stringify({ ok: picture.ok, probe })).toBe(true);
}, 30_000);

it('a stylesheet refused before the browser route cannot leave a successful picture', async () => {
  const options = world('<link rel=stylesheet href=http://www.example.com/site.css><p>Hello</p>');
  const observed = await capturePage(PAGE, options);
  expect(observed).toEqual({ ok: false, code: 'CAPTURE_HOST_NOT_CATALOGUED' });
  const probe: Probe = { requests: [] };
  const picture = await capturePicture(PAGE, options, browserPort(probe));
  expect(picture.ok, JSON.stringify(probe)).toBe(false);
}, 30_000);

it('browser integrity rejection cannot leave a successful picture without the observed stylesheet', async () => {
  const integrity = `sha256-${'A'.repeat(43)}=`;
  const options = world(`<link rel=stylesheet href=/site.css integrity="${integrity}"><p>Hello</p>`);
  const observed = await capturePage(PAGE, options);
  expect(observed.ok && Object.keys(observed.value.stylesheets)).toEqual([SHEET]);
  const probe: Probe = { requests: [] };
  const picture = await capturePicture(PAGE, options, browserPort(probe));
  expect(!picture.ok || probe.colour === RED, JSON.stringify({ ok: picture.ok, probe })).toBe(true);
}, 30_000);
