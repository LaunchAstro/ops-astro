// SPDX-License-Identifier: AGPL-3.0-only
//
// The width-and-theme check report (MP-1-7): every page built so far has a
// picture at each width in the packet, in light; each dark picture waits for
// the dark theme (U04, MP-1-1); and no page scrolls sideways. A page is built
// once its route is registered, so a route added without pictures fails here.

import type { Packet } from './packet.ts';

// Read at run time: the web app's own types sit outside this program (`tsconfig.web.json`).
const registry = new URL('../../apps/web/src/routes.ts', import.meta.url).href;
const { ROUTES } = (await import(registry)) as {
  ROUTES: Record<string, { path: string; authenticated: boolean }>;
};

export type PageShot = { page: string; width: number; picture: string | null; overflow: number };

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
      if (shot === undefined || shot.picture === null) {
        failed += 1;
        lines.push(`FAIL ${name}-light: no picture`);
      } else if (shot.overflow > 0) {
        failed += 1;
        sideways += 1;
        pictures += 1;
        lines.push(`FAIL ${name}-light: scrolls sideways by ${shot.overflow} px`);
      } else {
        pictures += 1;
        lines.push(`ok ${name}-light: ${shot.picture}; no sideways scroll`);
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
