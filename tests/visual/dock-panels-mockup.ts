// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- states, widths and themes run one at a
   time, in order: one browser context at a time. */
//
// The local half of the dock panels' visual match (ruling (b)9): the mockup's
// Notifications panel (`p-notifs`, `p-notifs--info-tab`) and Team panel
// (`p-team`) beside the built ones, in the pinned renderer, at 1480, 900 and
// 390 in light and dark. Needs the private mockup, so it runs where the mockup
// is (ruling (a)); it is no required check and leaves `states.json` alone.
//
//   MOCKUP_DIR=<clone of the mockup> node tests/visual/dock-panels-mockup.ts --out DIR
//     [--captures <mockup inventory>/captures/DOCK]
//
// Mockup side: the inventory's scripted recipe (docs/mockup-inventory/DOCK.md,
// line 7): `/dashboard/` with `aa-dock-open` naming the panel, and the info
// tab clicked for `--info-tab`. Built side: the app served from source under
// the made-up session and reads, its dock tab pressed on the Projects board.
// Each part (dock-panels-parts.ts) is measured as the inventory's capture JSON
// measures a region; the verdict names each difference by part, property and
// both values. With --captures, each mockup drawing is held to the
// inventory's own capture of the state: the panel head's box, where one was
// captured at that width.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { launchChromium } from '../support/chromium.ts';
import { madeUpSession, serveApp } from './app-pages.ts';
import { load, MOCKUP_ORIGIN, openSide } from './capture.ts';
import {
  measureParts,
  STATES,
  verdictOf,
  type Box,
  type DockState,
  type Parts,
} from './dock-panels-parts.ts';
import { WIDTHS } from './gallery-views.ts';
import { answerMadeUp } from './made-up-api.ts';
import {
  checkMockupTree,
  checkRenderer,
  fetchAssets,
  liveRenderer,
  MODE,
  readAssets,
  readPacket,
  themesOf,
  type Packet,
  type Theme,
} from './packet.ts';

const DASHBOARD = '/dashboard/';
const BOARD = '/projects/';

const settle = (page: Page): Promise<void> => page.waitForTimeout(400);

/** Each click as the inventory's recipe makes it: the element's own click, in the page. */
async function press(page: Page, selectors: readonly string[]): Promise<void> {
  for (const selector of selectors) {
    await page.waitForSelector(selector, { state: 'attached' });
    await page.evaluate((one) => {
      (document.querySelector(one) as HTMLElement | null)?.click();
    }, selector);
    await settle(page);
  }
}

const pairs = (state: DockState, side: 'mockup' | 'built'): [string, string][] =>
  state.parts.map((part) => [part.name, part[side]]);

/** The panel, or the viewport where the side drew no panel. */
async function picture(page: Page, selector: string): Promise<Buffer> {
  const options = { animations: 'disabled', caret: 'hide', scale: 'css' } as const;
  const panel = page.locator(selector).filter({ visible: true }).first();
  return (await panel.count()) === 0 ? page.screenshot(options) : panel.screenshot(options);
}

/** The inventory's capture of the state at this width and theme: its panel head's box. */
function captured(
  dir: string | undefined,
  name: string,
): { file: string; head: Box | null } | null {
  if (dir === undefined) return null;
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return null;
  const capture = JSON.parse(readFileSync(file, 'utf8')) as {
    regions: { sel: string; box: Box }[];
  };
  const head = capture.regions.find((region) => region.sel.endsWith('header.dpanel__head'));
  return { file, head: head?.box ?? null };
}

type Sides = { mockup: Page; built: Page };

async function drawSides(
  state: DockState,
  at: {
    browser: Browser;
    packet: Packet;
    width: number;
    theme: Theme;
    app: URL;
    session: string;
    mockupDir: string;
    tree: string;
  },
): Promise<{ sides: Sides; close: () => Promise<void> }> {
  const { browser, packet, width, theme } = at;
  const mockupSide = await openSide(browser, packet, width, {
    mockupDir: at.mockupDir,
    tree: at.tree,
    theme,
  });
  await mockupSide.context.addInitScript(
    (open: string) => localStorage.setItem('aa-dock-open', open),
    state.mockup.open,
  );
  const builtSide = await openSide(browser, packet, width, {
    app: at.app,
    session: at.session,
    colorScheme: theme,
  });
  await answerMadeUp(builtSide.context);
  const close = async (): Promise<void> => {
    await Promise.all([mockupSide.context.close(), builtSide.context.close()]);
  };
  try {
    const mockup = await load(mockupSide, packet, `${MOCKUP_ORIGIN}${DASHBOARD}`);
    await settle(mockup);
    await press(mockup, state.mockup.clicks);
    const built = await load(builtSide, packet, new URL(BOARD, at.app).href);
    await built.locator(`.dock__tab[aria-label^="Open ${state.built.tab}"]`).first().click();
    const panel = state.parts.find((part) => part.name === 'panel')?.built ?? 'main';
    await built.waitForSelector(panel, { state: 'visible' });
    await settle(built);
    await press(built, state.built.clicks);
    if (mockupSide.unresolved.size > 0)
      console.warn(`dock-panels: mockup asked for ${[...mockupSide.unresolved].join(', ')}`);
    return { sides: { mockup, built }, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** One state at one width in one theme: both pictures, the verdict file, one summary block. */
async function oneView(
  state: DockState,
  at: Parameters<typeof drawSides>[1] & { out: string; captures: string | undefined },
): Promise<string> {
  const name = `${state.id}@${String(at.width)}-${at.theme}`;
  const { sides, close } = await drawSides(state, at);
  try {
    const mockup: Parts = await sides.mockup.evaluate(measureParts, pairs(state, 'mockup'));
    const built: Parts = await sides.built.evaluate(measureParts, pairs(state, 'built'));
    const panel = (side: 'mockup' | 'built'): string =>
      state.parts.find((part) => part.name === 'panel')?.[side] ?? 'body';
    writeFileSync(join(at.out, `${name}.mockup.png`), await picture(sides.mockup, panel('mockup')));
    writeFileSync(join(at.out, `${name}.built.png`), await picture(sides.built, panel('built')));
    const differences = verdictOf(mockup, built);
    const capture = captured(
      at.captures === undefined ? undefined : join(at.captures, state.id),
      `${String(at.width)}-${at.theme}`,
    );
    const live = mockup['head']?.box ?? null;
    const held =
      capture?.head === null || capture === null || live === null
        ? null
        : capture.head[0] === live[0] && capture.head[2] === live[2] && capture.head[3] === live[3];
    const verdict = {
      state: state.id,
      width: at.width,
      theme: at.theme,
      mockup: { address: DASHBOARD, dockOpen: state.mockup.open, parts: mockup },
      built: { address: sides.built.url(), tab: state.built.tab, parts: built },
      capture: capture === null ? null : { ...capture, liveHead: live, headHeld: held },
      differences,
      ok: differences.length === 0,
    };
    writeFileSync(join(at.out, `${name}.verdict.json`), `${JSON.stringify(verdict, null, 1)}\n`);
    const heldLine = held === false ? ' (the live mockup head is not the captured one)' : '';
    if (differences.length === 0) return `ok ${name}${heldLine}`;
    return [
      `FAIL ${name}: ${String(differences.length)} differences${heldLine}`,
      ...differences.map((d) => `  ${d.part} ${d.property}: mockup ${d.mockup}, built ${d.built}`),
    ].join('\n');
  } finally {
    await close();
  }
}

const mockupDir = process.env['MOCKUP_DIR'];
if (mockupDir === undefined) throw new Error('visual: set MOCKUP_DIR to the pinned mockup clone');
const option = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
};
const out = option('--out') ?? mkdtempSync(join(tmpdir(), 'dock-panels-mockup-'));
mkdirSync(out, { recursive: true });
const packet = readPacket();
const tree = checkMockupTree(mockupDir, packet.mockup);
await fetchAssets(readAssets(), packet);
const browser = await launchChromium(MODE);
checkRenderer(packet, liveRenderer(browser, MODE));
const { app, close } = await serveApp();
const blocks: string[] = [];
try {
  const session = madeUpSession(app, join(out, 'session'));
  for (const state of STATES) {
    for (const width of WIDTHS) {
      for (const theme of themesOf(packet)) {
        const captures = option('--captures');
        const at = { browser, packet, width, theme, app, session, mockupDir, tree, out, captures };
        blocks.push(await oneView(state, at));
      }
    }
  }
} finally {
  rmSync(join(out, 'session'), { recursive: true, force: true });
  await browser.close();
  await close();
}
writeFileSync(join(out, 'summary.txt'), `${blocks.join('\n')}\n`);
console.log(blocks.join('\n'));
process.exitCode = blocks.every((block) => block.startsWith('ok')) ? 0 : 1;
