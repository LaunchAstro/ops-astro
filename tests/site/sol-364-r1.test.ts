// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import {
  capturePage,
  capturePicture,
  PICTURE_BROWSER_ARGS,
  type CaptureOptions,
  type PictureBrowser,
  type TransportAnswer,
} from '../../packages/core-connectors/src/index.ts';
import { launchChromium } from '../support/chromium.ts';

const PAGE = 'https://www.example.com/about';
const FINAL = 'https://www.example.com/assets/index.html';
const RED = 'https://www.example.com/assets/site.css';
const BLUE = 'https://www.example.com/site.css';
const HTML = '<!doctype html><link rel=stylesheet href=site.css><p>Test</p>';

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
      if (request.url.href === PAGE && redirect)
        return Promise.resolve({
          kind: 'answer',
          status: 302,
          headers: { location: FINAL },
          body: new Uint8Array(),
        });
      return Promise.resolve(
        request.url.href === RED
          ? answer('p{color:red}', 'text/css')
          : request.url.href === BLUE
            ? answer('p{color:blue}', 'text/css')
            : answer(html, 'text/html; charset=utf-8'),
      );
    },
  };
}

function browserPort(probe: { colour?: string }): PictureBrowser {
  return async (url, route) => {
    const browser = await launchChromium({ args: [...PICTURE_BROWSER_ARGS] });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      await page.route('**/*', async (intercepted) => {
        const request = intercepted.request();
        const result = await route({
          url: request.url(),
          kind: request.resourceType(),
          mainFrame: request.isNavigationRequest() && request.frame() === page.mainFrame(),
        });
        if (result === null) await intercepted.abort();
        else await intercepted.fulfill(result);
      });
      await page.goto(url, { waitUntil: 'load' });
      probe.colour = await page.locator('p').evaluate((node) => getComputedStyle(node).color);
      return new Uint8Array(await page.screenshot());
    } finally {
      await browser.close();
    }
  };
}

it('Sol proof, criterion 1: shallow adoption-agency input stays within the linear capture bound', () => {
  const source = `
    import { capturePage } from './packages/core-connectors/src/capture/page.ts';
    const url = '${PAGE}';
    const body = '<b><p>' + '<span></span>'.repeat(150000) + '</b>';
    const start = performance.now();
    await capturePage(url, {
      pool: { agencyPages: [url], otherPages: [], closedPoolReviews: [] },
      resolve: async () => ['93.184.215.14'],
      transport: async () => ({ kind: 'answer', status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: new TextEncoder().encode(body) })
    });
    console.log(performance.now() - start);
  `;
  // A child deadline keeps a quadratic parser from freezing the proof runner.
  const run = () =>
    execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: process.cwd(),
      timeout: 3000,
      encoding: 'utf8',
    });
  expect(run).not.toThrow();
}, 10_000);

it('Sol proof, criterion correctness: picture retains the final document URL after a fenced redirect', async () => {
  const options = world(HTML, true);
  const observed = await capturePage(PAGE, options);
  expect(observed).toMatchObject({ ok: true, value: { url: FINAL } });
  if (observed.ok) expect(Object.keys(observed.value.stylesheets)).toEqual([RED]);
  const probe: { colour?: string } = {};
  const picture = await capturePicture(PAGE, options, browserPort(probe));
  if (picture.ok) expect(probe.colour).toBe('rgb(255, 0, 0)');
  else expect(picture.code).toBe('CAPTURE_BODY_MALFORMED');
}, 30_000);

it('Sol proof, criterion correctness: picture retains the final stylesheet URL for relative imports', async () => {
  const original = world(HTML);
  const child = 'https://www.example.com/assets/sub.css';
  const options: CaptureOptions = {
    ...original,
    transport: (request) => {
      if (request.url.href === BLUE)
        return Promise.resolve({
          kind: 'answer',
          status: 302,
          headers: { location: RED },
          body: new Uint8Array(),
        });
      if (request.url.href === RED)
        return Promise.resolve(answer('@import "sub.css";', 'text/css'));
      if (request.url.href === child) return Promise.resolve(answer('p{color:red}', 'text/css'));
      if (request.url.pathname === '/sub.css')
        return Promise.resolve(answer('p{color:blue}', 'text/css'));
      return original.transport(request);
    },
  };
  const observed = await capturePage(PAGE, options);
  expect(observed.ok).toBe(true);
  if (observed.ok) expect(Object.keys(observed.value.stylesheets)).toEqual([child, BLUE]);
  const probe: { colour?: string } = {};
  const picture = await capturePicture(PAGE, options, browserPort(probe));
  if (picture.ok) expect(probe.colour).toBe('rgb(255, 0, 0)');
  else expect(picture.code).toBe('CAPTURE_BODY_MALFORMED');
}, 30_000);

it('Sol proof, criterion correctness: picture honours a same-host base URL or refuses the capture', async () => {
  const options = world(HTML.replace('<link', '<base href=/assets/><link'));
  const observed = await capturePage(PAGE, options);
  expect(observed.ok).toBe(true);
  if (observed.ok) expect(Object.keys(observed.value.stylesheets)).toEqual([RED]);
  const probe: { colour?: string } = {};
  const picture = await capturePicture(PAGE, options, browserPort(probe));
  if (picture.ok) expect(probe.colour).toBe('rgb(255, 0, 0)');
  else expect(picture.code).toBe('CAPTURE_BODY_MALFORMED');
}, 30_000);
