// SPDX-License-Identifier: AGPL-3.0-only
//
// The app's own requests in a capture are fetched by the harness and fulfilled
// into the page, never continued over the browser's sockets. On the hosted
// runner Docker makes and removes bridge networks while the browser tests run;
// each interface change makes Linux Chromium drop its sockets
// (net::ERR_NETWORK_CHANGED), a module request lost that way left the app
// unmounted, and the capture waited out 30 s on `#app:empty` (the MP-1-4
// census, and look.ts under the MP-6-5 visual match). Reproduced in the pinned
// Playwright image with a dummy interface added and removed every 0.7 s.

import type { Browser, Route } from 'playwright';
import { expect, it } from 'vitest';
import { openSide } from './capture.ts';
import { readPacket } from './packet.ts';

const APP = new URL('http://127.0.0.1:5391');

/** The handler a side's context routes every request through, from a browser that records it. */
async function routeOfSide(): Promise<(route: Route) => Promise<void>> {
  let handler: ((route: Route) => Promise<void>) | undefined;
  const context = {
    route: (_pattern: string, given: (route: Route) => Promise<void>) => {
      handler = given;
      return Promise.resolve();
    },
    addInitScript: () => Promise.resolve(),
  };
  const browser = { newContext: () => Promise.resolve(context) } as unknown as Browser;
  await openSide(browser, readPacket(), 1480, { app: APP, colorScheme: 'light' });
  if (handler === undefined) throw new Error('openSide routed nothing');
  return handler;
}

it("a capture answers the app's module requests from the harness, never over a browser socket", async () => {
  const handle = await routeOfSide();
  const calls: string[] = [];
  const response = { status: () => 200 };
  const route = {
    request: () => ({ url: () => new URL('/@fs/packages/ui/src/index.ts', APP).href }),
    continue: () => {
      calls.push('continue');
      return Promise.resolve();
    },
    fallback: () => {
      calls.push('fallback');
      return Promise.resolve();
    },
    fetch: (options?: { maxRedirects?: number }) => {
      calls.push(`fetch maxRedirects=${String(options?.maxRedirects)}`);
      return Promise.resolve(response);
    },
    fulfill: (options: { response?: unknown }) => {
      calls.push(options.response === response ? 'fulfill fetched' : 'fulfill other');
      return Promise.resolve();
    },
  } as unknown as Route;
  await handle(route);
  // A redirect is the page's to follow, as it would be over the network.
  expect(calls).toEqual(['fetch maxRedirects=0', 'fulfill fetched']);
});
