// SPDX-License-Identifier: AGPL-3.0-only
//
// A page opened at the fixed clock and waited on until its app draws into
// `#app`. A page that never does fails with what it reported: its errors, its
// failed answers and the requests still open when the wait ran out, so a boot
// that threw or stalled reads as one rather than as a bare timeout.
//
// One failure is the machine's, not the app's. On Linux, Chromium fails every
// request in flight with ERR_NETWORK_CHANGED when the host's interfaces
// change, which a container's network coming up does (a docker compose test
// beside the visual suites on a hosted runner). The app's modules never
// arrive, so that boot is loaded again, at most TRIES times in all.

/* oxlint-disable no-await-in-loop -- a load is tried again only after the one before it was cut off */

import type { Page, Request } from 'playwright';

const NETWORK_CHANGED = 'net::ERR_NETWORK_CHANGED';
const TRIES = 3;

export async function boot(page: Page, url: string, clock: string): Promise<Page> {
  const watched = watch(page);
  await page.clock.setFixedTime(new Date(clock));
  for (let tries = 1; tries <= TRIES; tries += 1) {
    const before = watched.changes();
    const drawn = page
      .goto(url, { waitUntil: 'load' })
      .then(() => page.waitForFunction(() => document.querySelector('#app:empty') === null))
      .then(() => 'drawn' as const);
    const outcome = await Promise.race([drawn, watched.nextChange()]).catch((error: unknown) => {
      if (watched.changes() > before) return 'changed' as const;
      throw new Error(`visual: ${url} drew nothing in #app: ${watched.report()}`, { cause: error });
    });
    if (outcome === 'drawn') return page;
    // The cut-off load ends on its own when the next one replaces it.
    drawn.catch(() => {});
  }
  throw new Error(
    `visual: ${url} drew nothing in #app in ${String(TRIES)} loads: ${watched.report()}`,
  );
}

/** What the page reports from before it loads, and each time the network changes under it. */
function watch(page: Page): {
  report: () => string;
  changes: () => number;
  nextChange: () => Promise<'changed'>;
} {
  const seen: string[] = [];
  const open = new Set<Request>();
  let changes = 0;
  let waiting: (() => void)[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') seen.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => seen.push(`page error: ${error.message}`));
  page.on('request', (request) => open.add(request));
  page.on('requestfinished', (request) => open.delete(request));
  page.on('requestfailed', (request) => {
    open.delete(request);
    const reason = request.failure()?.errorText ?? 'no reason';
    seen.push(`failed: ${request.url()} (${reason})`);
    if (reason !== NETWORK_CHANGED) return;
    changes += 1;
    for (const wake of waiting) wake();
    waiting = [];
  });
  page.on('response', (response) => {
    if (response.status() >= 400) seen.push(`${String(response.status())}: ${response.url()}`);
  });
  return {
    report: () =>
      [...seen, ...[...open].map((request) => `pending: ${request.url()}`)].join('; ') ||
      'no error, failed answer or open request',
    changes: () => changes,
    nextChange: () =>
      new Promise((resolve) => {
        waiting.push(() => {
          resolve('changed');
        });
      }),
  };
}
