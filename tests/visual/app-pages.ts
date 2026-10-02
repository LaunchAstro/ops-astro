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
import type { Browser, Page } from 'playwright';
import { createServer } from 'vite';
import { launchChromium } from '../support/chromium.ts';
import { load, openSide, shoot, type Catalogue, type Side } from './capture.ts';
import { scrollMetrics } from './drift.ts';
import { answerMadeUp } from './made-up-api.ts';
import { fetchAssets, MODE, readAssets, readPacket, type Packet, type Theme } from './packet.ts';
import {
  addressOf,
  builtPages,
  intendedScreen,
  needsSession,
  overflowOf,
  type PageShot,
} from './report.ts';

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
  const browser = await launchChromium(MODE);
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

/** The parameters a page's address is filled with: a made-up task, business and document. */
export const MADE_UP_PARAMS = { key: 'T-1', business: 'alpha', document: 'privacy-policy' };

/** A built page drawn at one width in one theme: `<page>@<width>-<theme>`. */
export type BuiltPage = { id: string; name: string; width: number; theme: Theme; page: Page };

/** The two sides of one width and theme: signed out and signed in. */
export type Sides = { signedOut: Side; signedIn: Side };

/**
 * Every built page (or only `pages`) at each width in each theme, each on the
 * side its route asks for (a public page signed out, a working page signed
 * in), handed to `visit`, then closed. `route` sets each width and theme's
 * routes before its first page loads.
 */
export async function eachBuiltPage<T>(
  options: {
    browser: Browser;
    packet: Packet;
    app: URL;
    session: string;
    widths: readonly number[];
    themes: readonly Theme[];
    pages?: readonly string[] | undefined;
    route?: ((sides: Sides) => Promise<void>) | undefined;
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
        await options.route?.({ signedOut, signedIn });
        for (const id of options.pages ?? builtPages()) {
          const side = needsSession(id) ? signedIn : signedOut;
          const address = addressOf(id, MADE_UP_PARAMS) ?? '/';
          // A page that draws nothing is named, so a timed-out run says which one.
          let page: Awaited<ReturnType<typeof load>>;
          try {
            page = await load(side, packet, new URL(address, app).href);
          } catch (error) {
            throw new Error(`built page ${id} (${address}) drew nothing into #app`, {
              cause: error,
            });
          }
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
  /** Only these pages (a ticket's own captures); every built page when not given. */
  pages?: readonly string[];
  /** Made-up answers to the app's reads, by the end of the read's address (`operations/read`). */
  answers?: Readonly<Record<string, unknown>>;
}): Promise<PageShot[]> {
  const { mask } = JSON.parse(
    readFileSync(new URL('states.json', import.meta.url), 'utf8'),
  ) as Catalogue;
  mkdirSync(options.out, { recursive: true });
  const route = async (sides: Sides): Promise<void> => {
    // Made-up reads first; a page's own answers are routed after, so they are asked first.
    await answerMadeUp(sides.signedIn.context);
    for (const side of [sides.signedOut, sides.signedIn]) await answer(side, options.answers ?? {});
  };
  return eachBuiltPage({ ...options, route }, async ({ id, name, width, theme, page }) => {
    // The intended screen is checked before the picture counts.
    const intended = intendedScreen(id);
    const drew = await page.evaluate(screenOf);
    const [shot] = await shoot(page, name, { page: 'viewport' }, mask);
    const overflow = overflowOf(await page.evaluate(scrollMetrics));
    const picture = shot === undefined ? null : join(options.out, `${name}.page.png`);
    if (shot !== undefined && picture !== null) writeFileSync(picture, shot.png);
    const wrong = drew === intended ? {} : { wrongScreen: `drew ${String(drew)}, not ${intended}` };
    return { page: id, width, theme, picture, overflow, ...wrong };
  });
}

/** Each read named answers its made-up body; a route added last is asked first. */
export async function answer(
  side: Side,
  answers: Readonly<Record<string, unknown>>,
): Promise<void> {
  for (const [read, body] of Object.entries(answers)) {
    await side.context.route(`**/api/**/${read}`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
    );
  }
}

/** Which screen the app drew: its sign-in form, a gate, its server error, or the page itself. */
export function screenOf(): string {
  if (document.querySelector('.signin__form') !== null) return 'the sign-in form';
  // main.tsx draws one bare paragraph when it cannot reach the server.
  const bare = document.querySelector('#app > p:only-child')?.textContent ?? '';
  if (bare.includes('cannot reach its server')) return 'the server error';
  const title = document.querySelector('.readstate .empty__title')?.textContent ?? '';
  if (title.startsWith('You are already signed in')) return 'the already-signed-in gate';
  if (title.startsWith('No screen is registered')) return 'the not-found gate';
  return 'the page';
}
