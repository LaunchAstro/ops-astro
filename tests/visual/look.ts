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
import { launchChromium } from '../support/chromium.ts';
import { load, MOCKUP_ORIGIN, openSide, type Side } from './capture.ts';
import { madeUpSession, PAGE_PARAMS, serveApp } from './app-pages.ts';
import { answerMadeUp } from './made-up-api.ts';
import { LOOK_SCREENS, type LookProbe, type LookScreen } from './look/index.ts';
import {
  checkAssets,
  checkMockupTree,
  fetchAssets,
  MODE,
  readAssets,
  readPacket,
  type Theme,
} from './packet.ts';
import { addressOf } from './report.ts';

type Measured = Readonly<Record<string, string>>;
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

/** In the page: each asked property of the element, colours as the pixel they paint. */
function measure(input: { selector: string; props: readonly string[] }): Measured | null {
  const element = document.querySelector(input.selector);
  if (element === null) return null;
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const pen = canvas.getContext('2d', { willReadFrequently: true });
  const paint = (value: string): string => {
    if (pen === null || value === '' || value === 'none') return value;
    pen.clearRect(0, 0, 1, 1);
    pen.fillStyle = '#000';
    pen.fillStyle = value;
    pen.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = pen.getImageData(0, 0, 1, 1).data;
    return `rgba(${String(r)},${String(g)},${String(b)},${String(a)})`;
  };
  const out: Record<string, string> = {};
  for (const prop of input.props) {
    if (prop.startsWith('box.')) {
      const key = prop.slice(4) as 'width' | 'height' | 'x' | 'y';
      out[prop] = String(Math.round(box[key]));
    } else if (prop === 'font-family') {
      // The face that paints: load() has proved every bundled face resolves,
      // so the fallbacks after the first never draw.
      out[prop] = (style.fontFamily.split(',')[0] ?? '').trim().replaceAll('"', '');
    } else if (prop.includes('color')) {
      out[prop] = paint(style.getPropertyValue(prop));
    } else {
      out[prop] = style.getPropertyValue(prop);
    }
  }
  return out;
}

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

/** One element's values on one side, at one width and theme; the side is closed after. */
async function measureOn(side: Side, url: string, probe: LookProbe, on: 'mockup' | 'app') {
  try {
    const page = await load(side, packet, url, { open: probe[on].open });
    return await page.evaluate(measure, { selector: probe[on].selector, props: probe.props });
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
      const value = await measureOn(side, `${MOCKUP_ORIGIN}${probe.mockup.path}`, probe, 'mockup');
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

/** The app's values for one probe at one place, against the pinned mockup's. */
async function checkProbe(
  probe: LookProbe,
  at: { width: number; theme: Theme; app: URL; session: string },
  want: Measured | null | undefined,
): Promise<void> {
  const { width, theme, app, session } = at;
  const name = `${probe.id}@${key(width, theme)}`;
  if (want === undefined || want === null) {
    say(`red ${name}: no mockup value pinned (run --measure)`, true);
    return;
  }
  const side = await openSide(browser, packet, width, { app, session, colorScheme: theme });
  await answerMadeUp(side.context);
  const address = addressOf(probe.app.page, PAGE_PARAMS) ?? '/';
  const got = await measureOn(side, new URL(address, app).href, probe, 'app');
  if (got === null) {
    say(`red ${name}: the app draws no ${probe.app.selector}`, true);
    return;
  }
  // A ruling that moved the build off the mockup names the value it holds instead.
  const wanted = (prop: string): string | undefined =>
    probe.ruled?.find((r) => r.at === `${prop}@${theme}`)?.want ?? want[prop];
  const off = probe.props.filter((prop) => got[prop] !== wanted(prop));
  const why = off.map((p) => `${p} mockup ${String(wanted(p))} app ${String(got[p])}`);
  say(off.length === 0 ? `ok ${name}` : `red ${name}: ${why.join('; ')}`, off.length > 0);
}

/** Every probe of one screen in the app. */
async function checkScreen(screen: LookScreen, app: URL, session: string): Promise<void> {
  const pinned = JSON.parse(readFileSync(pinnedFile(screen), 'utf8')) as Pinned;
  if (pinned.mockup !== packet.mockup.commit) {
    say(
      `red ${screen.id}: pinned from ${pinned.mockup}, the packet pins ${packet.mockup.commit}`,
      true,
    );
    return;
  }
  for (const probe of screen.probes)
    for (const { width, theme } of placesOf(probe))
      await checkProbe(
        probe,
        { width, theme, app, session },
        pinned.probes[probe.id]?.[key(width, theme)],
      );
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
