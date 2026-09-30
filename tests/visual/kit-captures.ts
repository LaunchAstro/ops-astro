// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop -- widths, themes and surfaces run one at a
   time, in order: one browser context at a time, so each picture is drawn alone. */
//
// A surface drawn from its own kit component on MP-1-7's width-and-theme
// harness: the markup React renders for made-up props, under the product's
// own style sheets, loaded in the pinned headless shell at each width in each
// theme through `openSide` and `load` (bundled faces and the theme proved in
// use), one picture file and its sideways scroll per surface. Used where the
// app's page needs an API behind it to draw the surface at all (app-pages.ts
// serves none). No browser: the launch throws, so a capture test fails and
// never passes without drawing.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChromium } from '../support/chromium.ts';
import { load, openSide, shoot, type Side } from './capture.ts';
import { scrollMetrics } from './drift.ts';
import {
  fetchAssets,
  MODE,
  readAssets,
  readPacket,
  themesOf,
  type Packet,
  type Theme,
} from './packet.ts';
import { overflowOf, type PageShot } from './report.ts';

/** T4c's three capture widths: desktop, tablet and phone. */
export const WIDTHS = [1480, 900, 390] as const;

/** Where the surfaces are served; no request leaves the browser for it. */
const ORIGIN = 'http://surfaces.invalid';

/** A module's own style sheets, in the order it imports them. */
function sheetsOf(module: string): string[] {
  const at = new URL(`../../${module}`, import.meta.url);
  return [...readFileSync(at, 'utf8').matchAll(/^import '(\.\/styles\/[^']+\.css)';$/gmu)].map(
    ([, sheet]) => new URL(sheet ?? '', at).pathname,
  );
}

// The sheets the kit's index and the app's entry import, in their order. The
// fonts sheet is left out: `load` gives the bundled faces and proves them.
export const sheets = (): string[] =>
  [...sheetsOf('packages/ui/src/index.ts'), ...sheetsOf('apps/web/src/main.tsx')].filter(
    (sheet) => !sheet.endsWith('/0-fonts.css'),
  );

const css = (): string =>
  sheets()
    .map((sheet) => readFileSync(sheet, 'utf8'))
    .join('\n');

/** The document one surface draws in: the root marked with the theme, as the app marks it. */
export function documentOf(markup: string, theme: Theme, styles: string = css()): string {
  return (
    `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8">` +
    `<style>${styles}</style></head><body><div id="app"><main class="surface-capture">` +
    `${markup}</main></div></body></html>`
  );
}

export interface Surface {
  /** The picture's name: `<surface>@<width>-<theme>`. */
  readonly id: string;
  readonly markup: string;
}

type Draw = (markup: string, theme: Theme) => string;

/** Every surface at each width in each theme: the pictures, as MP-1-7's report reads them. */
export async function captureSurfaces(
  surfaces: readonly Surface[],
  out: string,
  draw: Draw = documentOf,
): Promise<PageShot[]> {
  const packet = readPacket();
  await fetchAssets(readAssets(), packet);
  mkdirSync(out, { recursive: true });
  const browser = await launchChromium(MODE);
  const shots: PageShot[] = [];
  try {
    for (const width of WIDTHS) {
      for (const theme of themesOf(packet)) {
        const side = await openSide(browser, packet, width, {
          app: new URL(ORIGIN),
          colorScheme: theme,
        });
        try {
          shots.push(...(await captureSide(side, { packet, surfaces, draw, out, width, theme })));
        } finally {
          await side.context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  return shots;
}

/** Every surface on one side: one width in one theme. */
async function captureSide(
  side: Side,
  at: {
    packet: Packet;
    surfaces: readonly Surface[];
    draw: Draw;
    out: string;
    width: number;
    theme: Theme;
  },
): Promise<PageShot[]> {
  const { packet, surfaces, draw, out, width, theme } = at;
  // Registered after the side's own rule, so it answers the surfaces' origin first.
  await side.context.route(`${ORIGIN}/**`, (route) => {
    const id = new URL(route.request().url()).pathname.slice(1);
    const surface = surfaces.find((one) => one.id === id);
    if (surface === undefined) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: draw(surface.markup, theme), contentType: 'text/html' });
  });
  const shots: PageShot[] = [];
  for (const surface of surfaces) {
    const page = await load(side, packet, `${ORIGIN}/${surface.id}`);
    const name = `${surface.id}@${width}-${theme}`;
    const [shot] = await shoot(page, name, { page: 'viewport' }, []);
    const overflow = overflowOf(await page.evaluate(scrollMetrics));
    await page.close();
    const picture = shot === undefined ? null : join(out, `${name}.page.png`);
    if (shot !== undefined && picture !== null) writeFileSync(picture, shot.png);
    shots.push({ page: surface.id, width, theme, picture, overflow });
  }
  return shots;
}
