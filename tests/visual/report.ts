// SPDX-License-Identifier: AGPL-3.0-only
//
// The width-and-theme check report (MP-1-7): every page built so far has a
// picture at each width in the packet, in light; each dark picture waits for
// the dark theme (U04, MP-1-1); and no page scrolls sideways. A page is built
// once its route is registered, so a route added without pictures fails here.
// A picture counts only when its file is there: a PNG as wide as the width it
// was taken at.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { PNG } from 'pngjs';
import type { Packet, Theme } from './packet.ts';

// Read at run time: the web app's own types sit outside this program (`tsconfig.web.json`).
const registry = new URL('../../apps/web/src/routes.ts', import.meta.url).href;
const { ROUTES } = (await import(registry)) as {
  ROUTES: Record<string, { path: string; authenticated: boolean }>;
};

export type PageShot = {
  page: string;
  width: number;
  /** The theme it was drawn in; light when not given (a light-only capture). */
  theme?: Theme | undefined;
  /** The picture file's path; null when nothing was captured. */
  picture: string | null;
  overflow: number;
};

export const DARK_PENDING = 'waiting for the dark theme (U04, MP-1-1)';

/** Every page built so far: each route the app registers. */
export const builtPages = (): string[] => Object.keys(ROUTES);

/** A page's address with its parameters filled, or undefined when one is not given. */
export function addressOf(
  page: string,
  params: Readonly<Record<string, string>>,
): string | undefined {
  const route = ROUTES[page];
  if (route === undefined) return undefined;
  let missing = false;
  const path = route.path.replaceAll(/:(\w+)/gu, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) missing = true;
    return encodeURIComponent(value ?? '');
  });
  return missing ? undefined : path;
}

/** Whether drawing the page needs a signed-in session. */
export const needsSession = (page: string): boolean => ROUTES[page]?.authenticated ?? false;

/** The registered page an address draws, or undefined when none does. */
export const pageAt = (path: string): string | undefined =>
  Object.keys(ROUTES).find((page) => ROUTES[page]?.path === path);

/** Why a picture file does not count for its width, or undefined when it does. */
export function pictureFault(picture: string, width: number): string | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(picture);
  } catch {
    return 'no picture';
  }
  let drawn: number;
  try {
    drawn = PNG.sync.read(bytes).width;
  } catch {
    return 'picture is not a PNG';
  }
  return drawn === width ? undefined : `picture is ${drawn} px wide, not ${width}`;
}

/** How far a page scrolls sideways, in CSS pixels; 0 when it does not. */
export const overflowOf = (metrics: { scrollWidth: number; clientWidth: number }): number =>
  Math.max(0, metrics.scrollWidth - metrics.clientWidth);

export function report(
  packet: Packet,
  pages: readonly string[],
  shots: readonly PageShot[],
): { lines: string[]; failed: number } {
  const lines: string[] = [];
  let failed = 0;
  let pictures = 0;
  let sideways = 0;
  for (const page of pages) {
    for (const width of packet.widths) {
      const name = `${page}@${width}`;
      const shot = shots.find((one) => one.page === page && one.width === width);
      const fault =
        shot?.picture === undefined || shot.picture === null
          ? 'no picture'
          : pictureFault(shot.picture, width);
      if (shot === undefined || fault !== undefined) {
        failed += 1;
        lines.push(`FAIL ${name}-light: ${fault ?? 'no picture'}`);
      } else if (shot.overflow > 0) {
        failed += 1;
        sideways += 1;
        pictures += 1;
        lines.push(`FAIL ${name}-light: scrolls sideways by ${shot.overflow} px`);
      } else {
        pictures += 1;
        lines.push(`ok ${name}-light: ${basename(shot.picture ?? '')}; no sideways scroll`);
      }
      lines.push(`pending ${name}-dark: ${packet.themes.dark}`);
    }
  }
  const expected = pages.length * packet.widths.length;
  const missing = expected - pictures;
  lines.push(
    `width-and-theme check: ${pages.length} page(s) at ${packet.widths.length} width(s): ` +
      `${pictures} light picture(s), ${missing === 0 ? 'none' : missing} missing; ` +
      `${expected} dark waiting for the dark theme; ` +
      `${sideways === 0 ? 'none scrolls' : `${sideways} scroll`} sideways`,
  );
  return { lines, failed };
}
