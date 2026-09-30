// SPDX-License-Identifier: AGPL-3.0-only
//
// A capture whose app never draws into `#app` fails with what the page was
// doing: its errors and the requests still open. A bare "timeout exceeded"
// reads the same for a slow boot, a stalled request and a boot that threw, so
// a real boot failure would pass for a flake. The page here is a stand-in
// served from a local port: one boot waits on a request that is never
// answered, one throws before it draws.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchChromium } from '../support/chromium.ts';
import { load, openSide } from './capture.ts';
import { MODE, readPacket } from './packet.ts';

const page = (boot: string): string =>
  `<!doctype html><div id="app"></div><script type="module">${boot}</script>`;
const BOOTS: Record<string, string> = {
  '/stalled': page(
    "await fetch('/api/never-answered'); document.querySelector('#app').textContent = 'x';",
  ),
  '/throws': page("throw new Error('the boot threw before drawing');"),
};

let server: Server;
let app: URL;
let browser: Browser;
const held: { end: () => void }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const body = BOOTS[request.url ?? ''];
    if (body !== undefined) {
      response.setHeader('content-type', 'text/html');
      response.end(body);
      return;
    }
    // The stalled request: held open until the test ends.
    held.push(response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  app = new URL(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
  browser = await launchChromium(MODE);
});

afterAll(async () => {
  for (const response of held) response.end();
  await browser.close();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

async function failureOf(path: string): Promise<string> {
  const side = await openSide(browser, readPacket(), 390, { app });
  side.context.setDefaultTimeout(2000);
  try {
    await load(side, readPacket(), new URL(path, app).href);
    return 'drew';
  } catch (error) {
    return String(error);
  } finally {
    await side.context.close();
  }
}

it('a capture whose boot waits on an unanswered request fails naming that request', async () => {
  const failure = await failureOf('/stalled');
  expect(failure).toContain('drew nothing in #app');
  expect(failure).toContain(`pending: ${app.origin}/api/never-answered`);
}, 20_000);

it('a capture whose boot throws fails naming the error', async () => {
  const failure = await failureOf('/throws');
  expect(failure).toContain('drew nothing in #app');
  expect(failure).toContain('page error: the boot threw before drawing');
}, 20_000);
