// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- screens, widths and themes run one at a time,
   in order: one browser context at a time, and each report line in a fixed order. */
//
// Look parity (UI-POLISH): named elements of each Stage 1 screen, measured in
// the app against the same elements measured in the pinned mockup.
//
//   MOCKUP_DIR=<clone of the mockup> node tests/visual/look.ts --measure [--screen ID]
//   node tests/visual/look.ts [--app URL] [--screen ID] [--out DIR]
//
// --measure reads each probe's element in the mockup at each width in both
// themes and pins the values in `look/<screen>.mockup.json`, with the mockup
// commit they came from, so the check needs no mockup clone and runs on CI.
// Without --measure the app is served from source (or taken at --app), draws
// the made-up reads (made-up-api.ts) under the made-up session, and each probe
// prints `ok` or `red` with the property that differs. Colours are compared as
// the pixel they paint, so an oklch token and the mockup's hex that paint the
// same colour agree; boxes are compared to the whole pixel.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { launchChromium } from '../support/chromium.ts';
import { load, MOCKUP_ORIGIN, openSide, type Side } from './capture.ts';
import { MADE_UP_PARAMS, madeUpSession, serveApp } from './app-pages.ts';
import { measure, type Measured } from './look-measure.ts';
import { answerMadeUp } from './made-up-api.ts';
import { LOOK_SCREENS, RULED_PAINT, type LookProbe, type LookScreen } from './look/index.ts';
import {
  checkAssets,
  checkMockupTree,
  fetchAssets,
  MODE,
  readAssets,
  readPacket,
  type Theme,
} from './packet.ts';
import { addressOf, needsSession } from './report.ts';

interface Pinned {
  readonly about: string;
  readonly mockup: string;
  readonly probes: Readonly<Record<string, Readonly<Record<string, Measured | null>>>>;
}

const THEMES: readonly Theme[] = ['light', 'dark'];
const args = process.argv.slice(2);
const option = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};
const only = option('--screen');
const screens = LOOK_SCREENS.filter((screen) => only === undefined || screen.id === only);
if (screens.length === 0) throw new Error(`look: no screen ${String(only)}`);
const pinnedFile = (screen: LookScreen): URL =>
  new URL(`look/${screen.id}.mockup.json`, import.meta.url);
const widthsOf = (probe: LookProbe): readonly number[] => probe.widths ?? [1480];

const key = (width: number, theme: Theme): string => `${String(width)}-${theme}`;

const packet = readPacket();
await fetchAssets(readAssets(), packet);
checkAssets(packet);
const browser = await launchChromium(MODE);
let failed = 0;
const lines: string[] = [];
const say = (line: string, red = false): void => {
  lines.push(line);
  console.log(line);
  if (red) failed += 1;
};

/** Every width and theme a probe is measured at. */
const placesOf = (probe: LookProbe): { width: number; theme: Theme }[] =>
  widthsOf(probe).flatMap((width) => THEMES.map((theme) => ({ width, theme })));

/** Drags an element's centre along x, as a person drags an edge; false when nothing is there to grip. */
async function dragBy(page: Page, drag: { selector: string; by: number }): Promise<boolean> {
  const grip = await page.locator(drag.selector).boundingBox();
  if (grip === null) return false;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(grip.x + grip.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + drag.by, y, { steps: 4 });
  await page.mouse.up();
  return true;
}

/** Each probe's element values, as the page draws them now. */
const readAll = (page: Page, probes: readonly LookProbe[], on: 'mockup' | 'app') =>
  Promise.all(
    probes.map((probe) =>
      page.evaluate(measure, { selector: probe[on].selector, props: probe.props }),
    ),
  );

/**
 * Each probe's element values on one side, at one width and theme, from one
 * load: the probes share how the page is drawn and prepared, so each would
 * load and prepare the same page. Only reads follow the preparation, so no
 * probe's reading moves another's. The side is closed after.
 */
async function measureOn(
  side: Side,
  url: string,
  probes: readonly LookProbe[],
  on: 'mockup' | 'app',
): Promise<(Measured | null)[]> {
  const { open, store, drag } = probes[0]?.[on] ?? {};
  try {
    if (store !== undefined)
      await side.context.addInitScript((entries: [string, string][]) => {
        for (const [name, value] of entries) localStorage.setItem(name, value);
      }, Object.entries(store));
    const page = await load(side, packet, url, { open });
    // An app element drawn from its own read (the panel's Project select asks
    // task.board) comes after the first paint: wait for it, so a slow answer
    // is not read as "draws no"; one never drawn is still null after 5s.
    if (on === 'app') {
      for (const probe of probes) {
        await page
          .waitForSelector(probe.app.selector, { state: 'attached', timeout: 5000 })
          .catch(() => null);
      }
    }
    if (drag !== undefined && !(await dragBy(page, drag))) return probes.map(() => null);
    // Measured at rest: every transition the preparation started has landed.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((each) => each instanceof CSSTransition)
          .map((each) => each.finished.catch(() => each)),
      ),
    );
    const read = () => readAll(page, probes, on);
    // The dev server injects each style sheet as its module loads, so an early read can
    // catch a block before its look applies (13px for 14px, 16px for 48px padding). Read
    // until two reads 100ms apart agree, for at most two seconds.
    let last = await read();
    for (let tries = 0; tries < 20; tries += 1) {
      await page.waitForTimeout(100);
      const next = await read();
      if (JSON.stringify(next) === JSON.stringify(last)) return next;
      last = next;
    }
    return last;
  } finally {
    await side.context.close();
  }
}

/** --measure: the mockup's values for every probe of one screen, pinned to its commit. */
async function pinScreen(screen: LookScreen, mockupDir: string, tree: string): Promise<void> {
  const probes: Record<string, Record<string, Measured | null>> = {};
  for (const probe of screen.probes) {
    const values: Record<string, Measured | null> = {};
    for (const { width, theme } of placesOf(probe)) {
      const side = await openSide(browser, packet, width, { mockupDir, tree, theme });
      const [value = null] = await measureOn(
        side,
        `${MOCKUP_ORIGIN}${probe.mockup.path}`,
        [probe],
        'mockup',
      );
      values[key(width, theme)] = value;
      say(
        `${value === null ? 'red' : 'measured'} ${probe.id}@${key(width, theme)}`,
        value === null,
      );
    }
    probes[probe.id] = values;
  }
  const pinned: Pinned = {
    about: `Mockup values for tests/visual/look/${screen.id}.ts, from look.ts --measure.`,
    mockup: packet.mockup.commit,
    probes,
  };
  writeFileSync(pinnedFile(screen), `${JSON.stringify(pinned, null, 2)}\n`);
}

/** One probe at one width and theme, with the mockup values pinned for it there. */
interface Place {
  readonly probe: LookProbe;
  readonly width: number;
  readonly theme: Theme;
  readonly want: Measured | null;
}

/** A place's line: `ok`, or `red` with each property that differs. */
function verdict(place: Place, got: Measured | null): readonly [string, boolean] {
  const { probe, width, theme, want } = place;
  const name = `${probe.id}@${key(width, theme)}`;
  if (want === null) return [`red ${name}: no mockup value pinned (run --measure)`, true];
  if (got === null) return [`red ${name}: the app draws no ${probe.app.selector}`, true];
  // A ruling that moved the build off the mockup names the value it holds instead.
  const wanted = (prop: string): string | undefined =>
    probe.ruled?.find((r) => r.at === `${prop}@${theme}`)?.want ??
    RULED_PAINT.find((r) => r.theme === theme && r.mockup === want[prop])?.want ??
    want[prop];
  const off = probe.props.filter((prop) => got[prop] !== wanted(prop));
  const why = off.map((p) => `${p} mockup ${String(wanted(p))} app ${String(got[p])}`);
  return off.length === 0 ? [`ok ${name}`, false] : [`red ${name}: ${why.join('; ')}`, true];
}

/** The app's values at places drawn alike, from one load, each against its pinned mockup's. */
async function checkAlike(
  places: readonly Place[],
  app: URL,
  session: string,
): Promise<(readonly [string, boolean])[]> {
  const [first] = places;
  if (first === undefined) return [];
  const { width, theme } = first;
  // A public page (sign-in) is measured signed out, as the harness draws it;
  // an address the probe names is drawn signed in.
  const target = first.probe.app;
  const signedIn = target.path !== undefined || needsSession(target.page) ? { session } : {};
  const side = await openSide(browser, packet, width, { app, ...signedIn, colorScheme: theme });
  await answerMadeUp(side.context, target.reads);
  const address = target.path ?? addressOf(target.page, MADE_UP_PARAMS) ?? '/';
  const probes = places.map((place) => place.probe);
  const got = await measureOn(side, new URL(address, app).href, probes, 'app');
  return places.map((place, at) => verdict(place, got[at] ?? null));
}

/** Every probe of one screen in the app, one line per probe, width and theme, in order. */
async function checkScreen(screen: LookScreen, app: URL, session: string): Promise<void> {
  const pinned = JSON.parse(readFileSync(pinnedFile(screen), 'utf8')) as Pinned;
  if (pinned.mockup !== packet.mockup.commit) {
    say(
      `red ${screen.id}: pinned from ${pinned.mockup}, the packet pins ${packet.mockup.commit}`,
      true,
    );
    return;
  }
  const places: Place[] = screen.probes.flatMap((probe) =>
    placesOf(probe).map(({ width, theme }) => ({
      probe,
      width,
      theme,
      want: pinned.probes[probe.id]?.[key(width, theme)] ?? null,
    })),
  );
  // Places that draw the app alike (the same page, address, reads and
  // preparation, at one width and theme) differ only in the element read, so
  // they share one load; a place with no pinned value loads nothing.
  const alike = new Map<string, Place[]>();
  for (const place of places) {
    if (place.want === null) continue;
    const drawn = JSON.stringify([
      { ...place.probe.app, selector: undefined },
      place.width,
      place.theme,
    ]);
    alike.set(drawn, [...(alike.get(drawn) ?? []), place]);
  }
  const lineOf = new Map<Place, readonly [string, boolean]>();
  for (const group of alike.values()) {
    const said = await checkAlike(group, app, session);
    group.forEach((place, at) => {
      const line = said[at];
      if (line !== undefined) lineOf.set(place, line);
    });
  }
  for (const place of places) say(...(lineOf.get(place) ?? verdict(place, null)));
}

try {
  if (args.includes('--measure')) {
    const mockupDir = process.env['MOCKUP_DIR'];
    if (mockupDir === undefined) throw new Error('look: --measure needs MOCKUP_DIR');
    const tree = checkMockupTree(mockupDir, packet.mockup);
    for (const screen of screens) await pinScreen(screen, mockupDir, tree);
  } else {
    const served = option('--app') === undefined ? await serveApp() : undefined;
    const app = served?.app ?? new URL(option('--app') ?? '');
    const out = option('--out') ?? new URL('../../.local/evidence/look', import.meta.url).pathname;
    mkdirSync(out, { recursive: true });
    const session = madeUpSession(app, out);
    try {
      for (const screen of screens) await checkScreen(screen, app, session);
    } finally {
      await served?.close();
    }
    writeFileSync(`${out}/look.txt`, `${lines.join('\n')}\n`);
  }
} finally {
  await browser.close();
}
console.log(`look: ${failed === 0 ? 'green' : `${String(failed)} line(s) red`}`);
process.exitCode = failed === 0 ? 0 : 1;
