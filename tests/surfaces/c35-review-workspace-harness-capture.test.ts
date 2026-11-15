// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 on the width-and-theme harness (#2105): the Review workspace with a made-up review of
// two revisions, each landed at laptop and phone size, two pins and what changed, built from
// the shared kit with no private style, in light and dark at 1480, 900 and 390 in the pinned
// headless shell. No browser, no capture: the launch fails the test, never skips it.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { launchChromium } from '../support/chromium.ts';
import {
  answer,
  captureBuiltPages,
  MADE_UP_PARAMS,
  madeUpSession,
  serveApp,
} from '../visual/app-pages.ts';
import { load, openSide } from '../visual/capture.ts';
import { answerMadeUp } from '../visual/made-up-api.ts';
import { comparePng } from '../visual/compare.ts';
import { fetchAssets, MODE, readAssets, readPacket, themesOf } from '../visual/packet.ts';
import { addressOf, report } from '../visual/report.ts';
import { REVIEW } from '../visual/made-up-review.ts';

const scratch = mkdtempSync(join(tmpdir(), 'c35-captures-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const WIDTHS = [1480, 900, 390];
const PAGE = 'agency:review-workspace';

type Packet = ReturnType<typeof readPacket>;
type At = {
  readonly browser: Browser;
  readonly packet: Packet;
  readonly app: URL;
  readonly session: string;
};

const ANSWERS = { 'review/read': REVIEW };

/** The page at every width and theme: the report passes and each dark picture differs. */
async function capturedEverywhere(at: At, out: string): Promise<void> {
  const { packet } = at;
  const themes = themesOf(packet);
  expect(themes).toContain('dark');
  const shots = await captureBuiltPages({
    ...at,
    widths: WIDTHS,
    themes,
    out,
    pages: [PAGE],
    answers: ANSWERS,
  });
  const all = report({ ...packet, widths: WIDTHS }, [PAGE], shots);
  expect(all.failed, all.lines.join('\n')).toBe(0);
  const file = (width: number, theme: string): Buffer =>
    readFileSync(join(out, `${PAGE}@${width}-${theme}.page.png`));
  for (const width of WIDTHS) {
    const same = comparePng(`${PAGE}@${width}`, file(width, 'light'), file(width, 'dark'));
    expect(same.pass, `${PAGE}@${width} dark draws the same as light`).toBe(false);
  }
}

/** The pictures are of the workspace: four captures with the pins on them, no private style. */
async function workspaceDrawn(at: At): Promise<void> {
  const { browser, packet, app, session } = at;
  const side = await openSide(browser, packet, 390, { app, session });
  try {
    await answerMadeUp(side.context);
    await answer(side, ANSWERS);
    const address = new URL(addressOf(PAGE, MADE_UP_PARAMS) ?? '/', app).href;
    const shown = await load(side, packet, address);
    await shown.waitForSelector('[data-capture-picture]', { timeout: 10_000 });
    await shown.waitForFunction(
      () => document.querySelectorAll('[data-capture-picture]').length === 4,
    );
    expect(await shown.locator('[data-pin-spot]').count()).toBe(2);
    expect(await shown.locator('[data-difference="1480"] ins').textContent()).toBe('e-');
    expect(await shown.locator('[data-screen="review-workspace"] [style]').count()).toBe(0);
  } finally {
    await side.context.close();
  }
}

async function c35HarnessCapture(): Promise<void> {
  const packet = readPacket();
  await fetchAssets(readAssets(), packet);
  const browser = await launchChromium(MODE);
  const { app, close } = await serveApp();
  try {
    const out = join(scratch, 'review');
    const at = { browser, packet, app, session: madeUpSession(app, out) };
    await capturedEverywhere(at, out);
    await workspaceDrawn(at);
  } finally {
    await browser.close();
    await close();
  }
}

describe('C35 Review workspace on the width-and-theme harness (MP-1-7)', () => {
  it(
    'C35 harness captures: the Review workspace with its captures, pins and changes, in light and dark at 1480, 900 and 390',
    c35HarnessCapture,
    600_000,
  );
});
