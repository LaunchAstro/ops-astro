// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop -- widths and themes run one at a time, in order,
   one browser context each. */
//
// SL13's harness captures (MP-1-7): Keys (C31), Workflow triggers (C33) and the
// standing approval an activation names (C52-A) on the settings page; the fleet
// with one row open (MP-14-7a), signal (MP-14-8), skill costing (MP-14-9) and
// graduation (MP-14-10a) on Connections & signal. Each is drawn from the
// made-up reads at 1480, 900 and 390, light and dark: the region is on the page
// the app drew (never the sign-in form or a gate) and shows rows rather than
// its could-not-be-read state, nothing scrolls sideways, and each dark picture
// differs from its light one. The regions are the
// catalogue's (`states.json`), so the local mockup comparison (`run.ts`) reads
// the same ones. A screenshot proves the look only, never a permission or data.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChromium } from '../support/chromium.ts';
import { madeUpSession, screenOf, serveApp } from './app-pages.ts';
import { load, openSide, shoot, type Catalogue, type State } from './capture.ts';
import { comparePng } from './compare.ts';
import { scrollMetrics } from './drift.ts';
import { answerMadeUp } from './made-up-api.ts';
import { fetchAssets, MODE, readAssets, readPacket, themesOf, type Packet } from './packet.ts';
import { overflowOf } from './report.ts';

const WIDTHS = [1480, 900, 390] as const;

/** Each ticket's capture, by its state in the catalogue. */
const CAPTURES = [
  ['C31', 'c31-keys'],
  ['C33', 'c33-triggers'],
  ['C52-A', 'c52a-approvals'],
  ['MP-14-7a', 'mp-14-7a-fleet'],
  ['MP-14-8', 'mp-14-8-signal'],
  ['MP-14-9', 'mp-14-9-costing'],
  ['MP-14-10a', 'mp-14-10a-graduation'],
] as const;

/** The disclosure a person opens before the app's picture, as the mockup's state opens its own. */
const APP_OPEN: Readonly<Record<string, string>> = { 'mp-14-7a-fleet': '.conn__row' };

const catalogue = JSON.parse(
  readFileSync(new URL('states.json', import.meta.url), 'utf8'),
) as Catalogue;

function stateOf(id: string): State & { appPath: string } {
  const state = catalogue.states.find((each) => each.id === id);
  if (state?.appPath === undefined) throw new Error(`states.json has no app capture for ${id}`);
  return { ...state, appPath: state.appPath };
}

const scratch = mkdtempSync(join(tmpdir(), 'sl13-captures-'));
let packet: Packet;
let browser: Browser;
let app: URL;
let close: () => Promise<void>;
let session: string;

beforeAll(async () => {
  packet = readPacket();
  await fetchAssets(readAssets(), packet);
  // No browser, no capture: the launch fails every case, never skips it.
  browser = await launchChromium(MODE);
  ({ app, close } = await serveApp());
  session = madeUpSession(app, scratch);
}, 120_000);

afterAll(async () => {
  await browser.close();
  await close();
  rmSync(scratch, { recursive: true, force: true });
});

/** One state's regions at every width in every theme, each picture kept by its name. */
async function capture(id: string): Promise<Map<string, Buffer>> {
  const state = stateOf(id);
  const regions = state.appRegions ?? state.regions ?? {};
  const pictures = new Map<string, Buffer>();
  for (const width of WIDTHS) {
    for (const theme of themesOf(packet)) {
      const name = `${id}@${width}-${theme}`;
      const side = await openSide(browser, packet, width, { app, session, colorScheme: theme });
      await answerMadeUp(side.context);
      try {
        const address = new URL(state.appPath, app).href;
        const page = await load(side, packet, address, { open: APP_OPEN[id] });
        expect(await page.evaluate(screenOf), name).toBe('the page');
        for (const selector of Object.values(regions)) {
          const region = page.locator(selector).filter({ visible: true }).first();
          await region.waitFor();
          // The region drew the made-up rows, not its could-not-be-read state.
          expect(await region.innerText(), `${name} ${selector}`).not.toMatch(
            /could not be read/iu,
          );
        }
        for (const shot of await shoot(page, name, regions, catalogue.mask)) {
          writeFileSync(join(scratch, `${shot.name}.png`), shot.png);
          pictures.set(shot.name, shot.png);
        }
        expect(overflowOf(await page.evaluate(scrollMetrics)), `${name} scrolls sideways`).toBe(0);
      } finally {
        await side.context.close();
      }
    }
  }
  return pictures;
}

describe('SL13 on the width-and-theme harness (MP-1-7)', () => {
  it.each(CAPTURES)(
    '%s harness captures: %s at 1480, 900 and 390, light and dark',
    async (_ticket, id) => {
      const pictures = await capture(id);
      const regions = Object.keys(stateOf(id).appRegions ?? stateOf(id).regions ?? {});
      expect(pictures.size).toBe(WIDTHS.length * themesOf(packet).length * regions.length);
      // Each dark picture is drawn in dark: it differs from its light one.
      for (const width of WIDTHS)
        for (const region of regions) {
          const light = pictures.get(`${id}@${width}-light#${region}`) ?? Buffer.alloc(0);
          const dark = pictures.get(`${id}@${width}-dark#${region}`) ?? Buffer.alloc(0);
          const same = comparePng(`${id}@${width}#${region}`, light, dark);
          expect(same.pass, `${id}@${width}#${region} dark draws the same as light`).toBe(false);
        }
    },
    600_000,
  );
});
