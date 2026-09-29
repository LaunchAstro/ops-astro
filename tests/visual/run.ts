// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- widths, states and pages run one at a time,
   in order: a comparison is only deterministic while one thing draws */
//
// The visual comparison (T4c): the app against the pinned mockup, rendered at
// the same width, never against a previous run of the app.
//
//   MOCKUP_DIR=<clone of the mockup> node tests/visual/run.ts [--app URL [--session FILE] [--task KEY]]
//     [--prove-drift] [--out DIR]
//
// Every width in the packet is captured in each theme the packet captures:
// light, and dark from U04 (MP-1-1); while dark is pending it prints as
// undischarged. Without --app each drawn state prints red: T4b1 drives the
// app into the states this captures, from T4a's fixture, at a local address.
// --prove-drift is `visual_fails_on_drift` in the pinned renderer: an
// unchanged recapture of the mockup passes, and a control shifted by two
// pixels or one changed token colour fails, naming the capture.
// Evidence lands in DIR (default .local/evidence/visual, gitignored).
//
// MP-1-7 widens it to the boundary widths and adds the width-and-theme
// report: with --app, every page the app registers is captured at each width
// in each theme and measured for sideways scroll; the planted drift runs in
// each theme too (MP-1-1 dark harness bites); --session is a signed-in local
// fixture session (T4b1) as Playwright storage state, --task the key the task
// page opens. The report goes to DIR/width-and-theme.txt.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { comparePng } from './compare.ts';
import {
  load,
  MOCKUP_ORIGIN,
  openSide,
  shoot,
  type Catalogue,
  type State,
  type Side,
} from './capture.ts';
import {
  checkAssets,
  fetchAssets,
  readAssets,
  checkMockupTree,
  checkRenderer,
  liveRenderer,
  MODE,
  readPacket,
  themesOf,
  visualDir,
  type Theme,
} from './packet.ts';
import {
  addressOf,
  builtPages,
  needsSession,
  overflowOf,
  report,
  type PageShot,
} from './report.ts';

const args = process.argv.slice(2);
const option = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};
const out = option('--out') ?? new URL('../../.local/evidence/visual', import.meta.url).pathname;
const appArg = option('--app');
const app = appArg === undefined ? undefined : new URL(appArg);
if (app !== undefined && !['127.0.0.1', 'localhost'].includes(app.hostname)) {
  // Captures come from the local fixture only, never a served business's data.
  throw new Error(`visual: --app must be a local address, not ${app.host}`);
}
const mockupDir = process.env['MOCKUP_DIR'];
if (mockupDir === undefined)
  throw new Error('visual: set MOCKUP_DIR to a clone holding the pinned mockup commit');

const packet = readPacket();
await fetchAssets(readAssets(), packet);
checkAssets(packet);
const tree = checkMockupTree(mockupDir, packet.mockup);
const catalogue = JSON.parse(readFileSync(`${visualDir}states.json`, 'utf8')) as Catalogue;
mkdirSync(out, { recursive: true });

const lines: string[] = [];
let failed = 0;
const say = (line: string, fails = false): void => {
  if (fails) failed += 1;
  lines.push(line);
  console.log(line);
};

const session = option('--session');
const task = option('--task');
const shots: PageShot[] = [];

const browser = await chromium.launch(MODE);
const sides: Side[] = [];
try {
  checkRenderer(packet, liveRenderer(browser, MODE));
  say(`renderer ${JSON.stringify(packet.renderer)}; tolerance ${JSON.stringify(packet.tolerance)}`);
  say(`mockup tree ${tree}; ${catalogue.screenshots}`);
  for (const width of packet.widths) {
    for (const theme of themesOf(packet)) {
      const at = `${width}-${theme}`;
      const mockup = await openSide(browser, packet, width, theme, { mockupDir, tree });
      const appSide =
        app === undefined
          ? undefined
          : await openSide(browser, packet, width, theme, { app, session });
      sides.push(mockup, ...(appSide === undefined ? [] : [appSide]));
      for (const state of catalogue.states)
        await compareState(width, theme, state, mockup, appSide);
      if (appSide !== undefined && app !== undefined)
        await capturePages(width, theme, appSide, app);
      const external = [...mockup.external].toSorted();
      const listed = Object.keys(packet.external).toSorted();
      say(
        `blocked and served locally at ${at}: ${external.length} of ${listed.length} listed address(es)`,
      );
      const unresolved = [...mockup.unresolved, ...(appSide?.unresolved ?? [])];
      if (JSON.stringify(external) !== JSON.stringify(listed) || unresolved.length > 0) {
        say(
          `FAIL blocked list at ${at}: served ${external.join(' ')}; unresolved ${unresolved.join(' ') || 'none'}`,
          true,
        );
      }
    }
  }
} finally {
  await Promise.all(sides.map((side) => side.context.close()));
  await browser.close();
}

/** One state at one width in one theme: the mockup's regions, then the app's, compared. */
async function compareState(
  width: number,
  theme: Theme,
  state: State,
  mockup: Side,
  appSide?: Side,
): Promise<void> {
  if (!themesOf(packet).includes('dark'))
    say(`undischarged ${state.id}@${width}-dark: ${packet.themes.dark}`);
  const name = `${state.id}@${width}-${theme}`;
  if (state.mockup === null) {
    say(`no visual reference ${name}: ${String(state.reason)}`);
    return;
  }
  const regions = state.regions ?? {};
  const page = await load(mockup, packet, `${MOCKUP_ORIGIN}${state.mockup}`, state);
  const expected = await shoot(page, name, regions, catalogue.mask);
  for (const shot of expected) writeFileSync(`${out}/${shot.name}.mockup.png`, shot.png);
  if (catalogue.drift.state === state.id && args.includes('--prove-drift')) {
    await proveDrift(page, name, regions, expected);
  }
  await page.close();
  if (appSide === undefined || app === undefined || state.appPath === undefined) {
    for (const shot of expected)
      say(`red ${shot.name}: no app capture; ${String(state.app)}`, true);
    return;
  }
  const appPage = await load(appSide, packet, new URL(state.appPath, app).href, {});
  const actual = await shoot(appPage, name, state.appRegions ?? regions, catalogue.mask);
  await appPage.close();
  for (const [i, shot] of actual.entries()) {
    const verdict = comparePng(shot.name, expected[i]?.png ?? Buffer.alloc(0), shot.png);
    writeFileSync(`${out}/${shot.name}.app.png`, shot.png);
    if (verdict.diff !== undefined) writeFileSync(`${out}/${shot.name}.diff.png`, verdict.diff);
    say(verdict.line, !verdict.pass);
  }
}

async function proveDrift(
  page: Page,
  name: string,
  regions: Record<string, string>,
  base: { name: string; png: Buffer }[],
): Promise<void> {
  const verdicts = async (): Promise<ReturnType<typeof comparePng>[]> =>
    (await shoot(page, name, regions, catalogue.mask)).map((s, i) =>
      comparePng(s.name, base[i]?.png ?? Buffer.alloc(0), s.png),
    );
  const unchanged = await verdicts();
  for (const v of unchanged) say(`drift, unchanged recapture: ${v.line}`, !v.pass);
  const { control, token } = catalogue.drift;
  const shift = await page.addStyleTag({ content: `${control}{position:relative;left:2px}` });
  for (const v of await verdicts())
    say(
      `drift, control ${control} shifted 2px: ${v.line}`,
      v.pass && v.capture.endsWith('#gatebox'),
    );
  await shift.evaluate((node) => (node as Element).remove());
  // The token's own value, shifted a little towards black, on every element
  // that could define it, so the change reaches wherever the token is set.
  const original = await page.evaluate(
    (t) => getComputedStyle(document.body).getPropertyValue(t).trim(),
    token,
  );
  const colour = `*{${token}:color-mix(in oklch, ${original} 96%, black) !important}`;
  await page.addStyleTag({ content: colour });
  for (const v of await verdicts())
    say(`drift, token ${token} changed: ${v.line}`, v.pass && v.capture.endsWith('#gatebox'));
  // The sideways-scroll measure bites: an element 40px wider than the viewport.
  await page.addStyleTag({
    content: 'body::after{content:"";display:block;width:calc(100vw + 40px);height:1px}',
  });
  const planted = overflowOf(await page.evaluate(scrollMetrics));
  say(`overflow, planted 40px: ${name} scrolls sideways by ${planted} px`, planted === 0);
}

function scrollMetrics(): { scrollWidth: number; clientWidth: number } {
  const root = document.documentElement;
  return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
}

/** Every page the app registers, at one width in one theme: a picture and its sideways scroll. */
async function capturePages(width: number, theme: Theme, side: Side, origin: URL): Promise<void> {
  for (const id of builtPages()) {
    const name = `${id}@${width}-${theme}`;
    const address = addressOf(id, task === undefined ? {} : { key: task });
    if (address === undefined || (needsSession(id) && session === undefined)) {
      say(`red ${name}: needs ${address === undefined ? '--task' : '--session'} (T4b1's fixture)`);
      continue;
    }
    const page = await load(side, packet, new URL(address, origin).href, {});
    const [shot] = await shoot(page, name, { page: 'viewport' }, catalogue.mask);
    const overflow = overflowOf(await page.evaluate(scrollMetrics));
    await page.close();
    const picture = `${name}.page.png`;
    if (shot !== undefined) writeFileSync(`${out}/${picture}`, shot.png);
    shots.push({
      page: id,
      width,
      theme,
      picture: shot === undefined ? null : picture,
      overflow,
    });
  }
}

if (app !== undefined) {
  const pages = report(packet, builtPages(), shots);
  for (const line of pages.lines) say(line, false);
  failed += pages.failed;
  writeFileSync(`${out}/width-and-theme.txt`, `${pages.lines.join('\n')}\n`);
}
writeFileSync(`${out}/summary.txt`, `${lines.join('\n')}\n`);
console.log(`\nvisual: ${failed === 0 ? 'pass' : `${failed} line(s) red`}; evidence in ${out}`);
process.exitCode = failed === 0 ? 0 : 1;
