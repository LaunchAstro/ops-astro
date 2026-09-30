// SPDX-License-Identifier: AGPL-3.0-only
//
// A page opened at the fixed clock and waited on until its app draws into
// `#app`. A page that never does fails with what it reported: its errors, its
// failed answers and the requests still open when the wait ran out, so a boot
// that threw or stalled reads as one rather than as a bare timeout.

import type { Page, Request } from 'playwright';

export async function boot(page: Page, url: string, clock: string): Promise<Page> {
  const seen: string[] = [];
  const open = new Set<Request>();
  page.on('console', (message) => {
    if (message.type() === 'error') seen.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => seen.push(`page error: ${error.message}`));
  page.on('request', (request) => open.add(request));
  page.on('requestfinished', (request) => open.delete(request));
  page.on('requestfailed', (request) => {
    open.delete(request);
    seen.push(`failed: ${request.url()} (${request.failure()?.errorText ?? 'no reason'})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) seen.push(`${String(response.status())}: ${response.url()}`);
  });
  await page.clock.setFixedTime(new Date(clock));
  await page.goto(url, { waitUntil: 'load' });
  await page
    .waitForFunction(() => document.querySelector('#app:empty') === null)
    .catch((error) => {
      const pending = [...open].map((request) => `pending: ${request.url()}`);
      const report = [...seen, ...pending].join('; ') || 'no error, failed answer or open request';
      throw new Error(`visual: ${url} drew nothing in #app: ${report}`, { cause: error });
    });
  return page;
}
