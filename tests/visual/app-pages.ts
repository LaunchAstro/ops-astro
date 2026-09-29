// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop -- widths, themes and pages run one at a time,
   in order: one browser context at a time, and each report line in a fixed order. */
//
// Every page the app registers, drawn in a real browser at each width in each
// theme: a picture file and its sideways scroll, for the width-and-theme
// report (MP-1-7) that MP-1-1's harness-captures test reads, with the regions
// the catalogue masks (`states.json`). The session is
// made up (`made-up-session.json`): the pages ask for one before they draw,
// and none of them needs a record to draw its frame.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { createServer } from 'vite';
import { load, openSide, shoot, type Catalogue, type Side } from './capture.ts';
import { scrollMetrics } from './drift.ts';
import type { Packet, Theme } from './packet.ts';
import { addressOf, builtPages, overflowOf, type PageShot } from './report.ts';

/** The app served from source by its own Vite config, at a free local port. */
export async function serveApp(): Promise<{ app: URL; close: () => Promise<void> }> {
  const server = await createServer({
    configFile: new URL('../../apps/web/vite.config.ts', import.meta.url).pathname,
    logLevel: 'silent',
    server: { port: 0, strictPort: false },
  });
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
}): Promise<PageShot[]> {
  const { browser, packet, app, session } = options;
  const { mask } = JSON.parse(
    readFileSync(new URL('states.json', import.meta.url), 'utf8'),
  ) as Catalogue;
  mkdirSync(options.out, { recursive: true });
  const shots: PageShot[] = [];
  for (const width of options.widths) {
    for (const theme of options.themes) {
      const side = await openSide(browser, packet, width, { app, session, colorScheme: theme });
      try {
        shots.push(...(await capturePages(side, { ...options, mask, width, theme })));
      } finally {
        await side.context.close();
      }
    }
  }
  return shots;
}

/** Every built page on one side, at its width in its theme. */
async function capturePages(
  side: Side,
  at: { packet: Packet; app: URL; width: number; theme: Theme; mask: string[]; out: string },
): Promise<PageShot[]> {
  const { packet, app, width, theme, mask, out } = at;
  const shots: PageShot[] = [];
  for (const id of builtPages()) {
    const name = `${id}@${width}-${theme}`;
    const address = addressOf(id, { key: 'T-1' }) ?? '/';
    const page = await load(side, packet, new URL(address, app).href);
    const [shot] = await shoot(page, name, { page: 'viewport' }, mask);
    const overflow = overflowOf(await page.evaluate(scrollMetrics));
    await page.close();
    const picture = shot === undefined ? null : join(out, `${name}.page.png`);
    if (shot !== undefined && picture !== null) writeFileSync(picture, shot.png);
    shots.push({ page: id, width, theme, picture, overflow });
  }
  return shots;
}
