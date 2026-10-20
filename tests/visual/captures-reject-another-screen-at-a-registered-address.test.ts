// SPDX-License-Identifier: AGPL-3.0-only
//
// A built page's capture counts only when the address drew that page: the
// app's own shell, under the route's own title. Another of the app's screens
// served at the address (the component gallery at /projects/), or a document
// that is not the app at all, is a wrong screen, never the page. A page drawn
// in the sign-in form's card (the password reset) is not the sign-in form;
// the sign-in screen itself at that address is. The browser
// is a stand-in: each document is drawn in jsdom and read by the same
// functions the capture runs in Chromium.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- jsdom ships no declarations; this proof only reads its DOM document
import { JSDOM } from 'jsdom';
import type { Browser } from 'playwright';
import { afterEach, expect, it, vi } from 'vitest';
import { captureBuiltPages } from './app-pages.ts';
import { readPacket } from './packet.ts';

vi.mock('./capture.ts', () => ({
  openSide: () => ({ context: { close: () => {}, route: async () => {} } }),
  // The page answers each `evaluate` by running it against the served document.
  load: () => ({ evaluate: (read: () => unknown) => read(), close: () => {} }),
  shoot: () => [{ png: Buffer.from('capture stub') }],
}));

/** The app's shell, its top bar naming `title`, around `body`. */
const shell = (title: string, body: string): string =>
  `<div id="app"><div class="shell"><header class="topbar"><div class="topbar__title">` +
  `<h1 class="t-title"><span class="topbar__default-title">${title}</span>` +
  `<span class="topbar__record-title"></span></h1></div></header><main>${body}</main></div></div>`;

let dom: { window: { document: Document; close: () => void } } | undefined;
afterEach(() => {
  vi.unstubAllGlobals();
  dom?.window.close();
  dom = undefined;
});

/** What `page`'s capture reports when `html` is what its address drew. */
async function capturedFrom(page: string, html: string) {
  dom = new JSDOM(html) as typeof dom;
  vi.stubGlobal('document', dom?.window.document);
  const out = mkdtempSync(join(tmpdir(), 'wrong-screen-capture-'));
  try {
    const [shot] = await captureBuiltPages({
      browser: {} as Browser,
      packet: readPacket(),
      app: new URL('http://127.0.0.1:5391'),
      session: 'made-up-session.json',
      widths: [390],
      themes: ['light'],
      out,
      pages: [page],
    });
    return shot;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** What the Projects board's capture reports when `html` is what /projects/ drew. */
const projectsCapturedFrom = (html: string) => capturedFrom('agency:projects-board', html);

/** A screen drawn in the sign-in form's card, as `data-screen` names it. */
const card = (screen: string): string =>
  `<main class="signin" data-screen="${screen}"><form class="signin__form card"></form></main>`;

it('the Projects board drawn under its own title counts as the page', async () => {
  const shot = await projectsCapturedFrom(shell('Projects', '<table></table>'));
  expect(shot?.wrongScreen).toBeUndefined();
});

it('the component gallery drawn at the Projects address is a wrong screen', async () => {
  const shot = await projectsCapturedFrom(
    shell('Component gallery', '<section class="gallery"></section>'),
  );
  expect(shot?.wrongScreen).toBe('drew the page titled Component gallery, not Projects');
});

it('a document that is not the app, at the Projects address, is a wrong screen', async () => {
  const shot = await projectsCapturedFrom(
    '<div id="app"><section class="gallery"><h2>Buttons</h2></section></div>',
  );
  expect(shot?.wrongScreen).toBe('drew a document that is not the app, not the page');
});

it('the password reset, drawn in the sign-in card under its own title, counts as the page', async () => {
  const shot = await capturedFrom('agency:reset', shell('Reset your password', card('reset')));
  expect(shot?.wrongScreen).toBeUndefined();
});

it('the sign-in form drawn at the reset address is a wrong screen', async () => {
  const shot = await capturedFrom('agency:reset', shell('Reset your password', card('sign-in')));
  expect(shot?.wrongScreen).toBe('drew the sign-in form, not the page');
});
