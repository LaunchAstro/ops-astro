// SPDX-License-Identifier: AGPL-3.0-only
//
// Look parity reads the value an element settles on, not the start of a
// transition still in flight. In the harness the vite dev server injects the
// app's sheets after the body has its browser default style (black text), and
// reduced motion gives every element a 0.01ms transition of every property
// (1-tokens.css). A style change just before the read starts a transition
// whose first value is the old one, so dark text read as rgba(0,0,0,255) on
// a busy machine (M5 runs on ac83254: access and telemetry headings, dark).
// The stand-in page holds the same shape with a 10s transition, so the read
// lands inside it every time.

import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChromium } from '../support/chromium.ts';
import { measure } from './look-measure.ts';
import { MODE } from './packet.ts';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launchChromium(MODE);
  page = await browser.newPage();
  await page.setContent(
    '<!doctype html><style>*{transition-duration:10s}</style><h2 class="head">Access</h2>',
  );
}, 60_000);

afterAll(async () => {
  await browser.close();
});

it('a heading whose ink just changed is read at the ink it settles on', async () => {
  // The app's sheet lands after the body's first style: its ink moves from black.
  await page.addStyleTag({ content: 'body{color:rgb(248,248,248)}' });
  const got = await page.evaluate(measure, { selector: '.head', props: ['color'] });
  expect(got).toEqual({ color: 'rgba(248,248,248,255)' });
});
