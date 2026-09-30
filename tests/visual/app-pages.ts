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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer } from 'vite';
import { load, openSide, shoot, type Catalogue } from './capture.ts';
import { scrollMetrics } from './drift.ts';
import { fetchAssets, MODE, readAssets, readPacket, type Packet, type Theme } from './packet.ts';
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

/** The pinned browser and the served app, signed in with the made-up session. */
export type SignedInApp = { browser: Browser; packet: Packet; app: URL; session: string };

/**
 * Starts what every browser leg draws on, in its order: the packet's faces
 * fetched, the pinned browser, the app served from source and the made-up
 * session; hands them to `use` and closes them after. No browser: the launch
 * throws, so a test on what `use` draws fails and never skips.
 */
export async function withSignedInApp<T>(use: (at: SignedInApp) => Promise<T>): Promise<T> {
  const packet = readPacket();
  await fetchAssets(readAssets(), packet);
  const browser = await chromium.launch(MODE);
  const { app, close } = await serveApp();
  const dir = mkdtempSync(join(tmpdir(), 'made-up-session-'));
  try {
    return await use({ browser, packet, app, session: madeUpSession(app, dir) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await browser.close();
    await close();
  }
}

/** A built page drawn at one width in one theme: `<page>@<width>-<theme>`. */
export type BuiltPage = { id: string; name: string; width: number; theme: Theme; page: Page };

/**
 * Every built page at each width in each theme, each on the side its route
 * asks for (a public page signed out, a working page signed in), handed to
 * `visit`, then closed.
 */
export async function eachBuiltPage<T>(
  options: {
    browser: Browser;
    packet: Packet;
    app: URL;
    session: string;
    widths: readonly number[];
    themes: readonly Theme[];
  },
  visit: (built: BuiltPage) => Promise<T>,
): Promise<T[]> {
  const { browser, packet, app, session } = options;
  const out: T[] = [];
  for (const width of options.widths) {
    for (const theme of options.themes) {
      const signedOut = await openSide(browser, packet, width, { app, colorScheme: theme });
      const signedIn = await openSide(browser, packet, width, { app, session, colorScheme: theme });
      try {
        for (const id of builtPages()) {
          const side = needsSession(id) ? signedIn : signedOut;
          const address = addressOf(id, { key: 'T-1' }) ?? '/';
          const page = await load(side, packet, new URL(address, app).href);
          out.push(
            await visit({ id, name: `${id}@${String(width)}-${theme}`, width, theme, page }),
          );
          await page.close();
        }
      } finally {
        await Promise.all([signedOut.context.close(), signedIn.context.close()]);
      }
    }
  }
  return out;
}

export function captureBuiltPages(options: {
  browser: Browser;
  packet: Packet;
  app: URL;
  session: string;
  widths: readonly number[];
  themes: readonly Theme[];
  out: string;
}): Promise<PageShot[]> {
  const { mask } = JSON.parse(
    readFileSync(new URL('states.json', import.meta.url), 'utf8'),
  ) as Catalogue;
  mkdirSync(options.out, { recursive: true });
  return eachBuiltPage(options, async ({ id, name, width, theme, page }) => {
    // The intended screen is checked before the picture counts.
    const intended = needsSession(id) ? 'the page' : 'the sign-in form';
    const drew = await page.evaluate(screenOf);
    const [shot] = await shoot(page, name, { page: 'viewport' }, mask);
    const overflow = overflowOf(await page.evaluate(scrollMetrics));
    const picture = shot === undefined ? null : join(options.out, `${name}.page.png`);
    if (shot !== undefined && picture !== null) writeFileSync(picture, shot.png);
    const wrong = drew === intended ? {} : { wrongScreen: `drew ${String(drew)}, not ${intended}` };
    return { page: id, width, theme, picture, overflow, ...wrong };
  });
}

/** Which screen the app drew: its sign-in form, a gate, or the page itself. */
export function screenOf(): string {
  if (document.querySelector('.signin__form') !== null) return 'the sign-in form';
  const title = document.querySelector('.readstate .empty__title')?.textContent ?? '';
  if (title.startsWith('You are already signed in')) return 'the already-signed-in gate';
  if (title.startsWith('No screen is registered')) return 'the not-found gate';
  return 'the page';
}
