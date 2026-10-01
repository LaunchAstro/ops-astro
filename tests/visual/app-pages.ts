// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- widths, themes and pages run one at a time,
   in order: one width and theme at a time, and each report line in a fixed order. */
//
// Every page the app registers, drawn in a real browser at each width in each
// theme: a picture file and its sideways scroll, for the width-and-theme
// report (MP-1-7) that MP-1-1's harness-captures test reads, with the regions
// the catalogue masks (`states.json`). A public page (sign-in) is drawn signed
// out; a working page is drawn signed in with the made-up session
// (`made-up-session.json`), with no API behind the app, so a page that reads
// records draws its own frame in its could-not-be-read state (the records wait
// on T4b1's fixture). Each picture counts only when the page drew its own
// screen, never the sign-in form or a gate.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { createServer } from 'vite';
import { load, openSide, shoot, type Catalogue, type Side } from './capture.ts';
import { scrollMetrics } from './drift.ts';
import { answerMadeUp } from './made-up-api.ts';
import type { Packet, Theme } from './packet.ts';
import { addressOf, builtPages, needsSession, overflowOf, type PageShot } from './report.ts';

/** The app served from source by its own Vite config, at a free local port. */
export async function serveApp(): Promise<{ app: URL; close: () => Promise<void> }> {
  // No API behind it on any machine: its proxy points at a closed port, never at
  // an API another run left listening on the default one.
  const api = process.env['API_ORIGIN'];
  process.env['API_ORIGIN'] = 'http://127.0.0.1:9';
  const server = await createServer({
    configFile: new URL('../../apps/web/vite.config.ts', import.meta.url).pathname,
    logLevel: 'silent',
    server: { port: 0, strictPort: false },
  });
  if (api === undefined) delete process.env['API_ORIGIN'];
  else process.env['API_ORIGIN'] = api;
  await server.listen();
  return { app: new URL(server.resolvedUrls?.local[0] ?? ''), close: () => server.close() };
}

/** The made-up session file, rewritten for the origin the app is served at. */
export function madeUpSession(app: URL, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.json');
  const state = JSON.parse(
    readFileSync(new URL('made-up-session.json', import.meta.url), 'utf8'),
  ) as { origins: { origin: string }[] };
  for (const one of state.origins) one.origin = app.origin;
  writeFileSync(file, JSON.stringify(state));
  return file;
}

export async function captureBuiltPages(options: {
  browser: Browser;
  packet: Packet;
  app: URL;
  session: string;
  widths: readonly number[];
  themes: readonly Theme[];
  out: string;
  /** Only these pages (a ticket's own capture); every built page when left out. */
  pages?: readonly string[];
}): Promise<PageShot[]> {
  const { browser, packet, app, session } = options;
  const { mask } = JSON.parse(
    readFileSync(new URL('states.json', import.meta.url), 'utf8'),
  ) as Catalogue;
  mkdirSync(options.out, { recursive: true });
  const shots: PageShot[] = [];
  for (const width of options.widths) {
    for (const theme of options.themes) {
      // A public page (sign-in) is drawn signed out, a working page signed in.
      const signedOut = await openSide(browser, packet, width, { app, colorScheme: theme });
      const signedIn = await openSide(browser, packet, width, { app, session, colorScheme: theme });
      await answerMadeUp(signedIn.context);
      try {
        const sides = { signedOut, signedIn };
        shots.push(...(await capturePages(sides, { ...options, mask, width, theme })));
      } finally {
        await Promise.all([signedOut.context.close(), signedIn.context.close()]);
      }
    }
  }
  return shots;
}

/** Which screen the app drew: its sign-in form, a gate, or the page itself. */
export function screenOf(): string {
  if (document.querySelector('.signin__form') !== null) return 'the sign-in form';
  const title = document.querySelector('.readstate .empty__title')?.textContent ?? '';
  if (title.startsWith('You are already signed in')) return 'the already-signed-in gate';
  if (title.startsWith('No screen is registered')) return 'the not-found gate';
  return 'the page';
}

/** Every built page at one width in one theme, each on the side its route asks for. */
async function capturePages(
  sides: { signedOut: Side; signedIn: Side },
  at: {
    packet: Packet;
    app: URL;
    width: number;
    theme: Theme;
    mask: string[];
    out: string;
    pages?: readonly string[];
  },
): Promise<PageShot[]> {
  const { packet, app, width, theme, mask, out } = at;
  const shots: PageShot[] = [];
  for (const id of at.pages ?? builtPages()) {
    const name = `${id}@${width}-${theme}`;
    const address = addressOf(id, { key: 'T-1' }) ?? '/';
    const side = needsSession(id) ? sides.signedIn : sides.signedOut;
    const page = await load(side, packet, new URL(address, app).href);
    // The intended screen is checked before the picture counts.
    const intended = needsSession(id) ? 'the page' : 'the sign-in form';
    const drew = await page.evaluate(screenOf);
    const [shot] = await shoot(page, name, { page: 'viewport' }, mask);
    const overflow = overflowOf(await page.evaluate(scrollMetrics));
    await page.close();
    const picture = shot === undefined ? null : join(out, `${name}.page.png`);
    if (shot !== undefined && picture !== null) writeFileSync(picture, shot.png);
    const wrong = drew === intended ? {} : { wrongScreen: `drew ${String(drew)}, not ${intended}` };
    shots.push({ page: id, width, theme, picture, overflow, ...wrong });
  }
  return shots;
}
