// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- widths run one at a time, in order: a
   comparison is only deterministic while one thing draws */
//
// The app-only drift mode (`run.ts --app-drift`): drift proved on one of the
// app's own pages, in the theme asked for, with no mockup. It needs no clone
// of the private mockup and no key to it, so the public repository's CI runs
// it (the `visual drift` job) on Linux in the pinned headless shell; the live
// renderer, kernel release included, opens the evidence. At each width in
// the packet: the page is drawn in the asked theme, a dark drawing is proved
// to differ from the light one, an unchanged recapture passes, a control
// shifted 2px and a token colour changed each fail, a planted 40px overflow
// is measured, and the page itself must not scroll sideways.

import { writeFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { load, openSide, shoot, type Side } from './capture.ts';
import { comparePng } from './compare.ts';
import { proveDrift, scrollMetrics, type Say } from './drift.ts';
import {
  checkAssets,
  checkDriftRenderer,
  fetchAssets,
  liveRenderer,
  MODE,
  readAssets,
  readPacket,
  type Packet,
} from './packet.ts';
import { overflowOf } from './report.ts';

export type AppDrift = {
  /** What the report names the page by: its route id, or a case's own label. */
  label: string;
  /** The page's address under the app's origin. */
  address: string;
  control: string;
  token: string;
  theme: 'light' | 'dark';
};

type Run = {
  app: URL;
  session?: string | undefined;
  drift: AppDrift;
  mask: string[];
  out: string;
  say: Say;
  browser: Browser;
  packet: Packet;
  sides: Side[];
  url: string;
};
type Shot = { name: string; png: Buffer };

const regions = { page: 'viewport' };

export async function appDrift(options: {
  app: URL;
  session?: string | undefined;
  drift: AppDrift;
  mask: string[];
  out: string;
  say: Say;
}): Promise<void> {
  const { app, drift, say } = options;
  const packet = readPacket();
  await fetchAssets(readAssets(), packet);
  checkAssets(packet);
  const browser = await chromium.launch(MODE);
  const sides: Side[] = [];
  try {
    const live = liveRenderer(browser, MODE);
    const pin = checkDriftRenderer(packet, live);
    say(`renderer ${JSON.stringify(live)}; held to ${JSON.stringify(pin)}`);
    say(`app-only drift: ${drift.label} at ${drift.address} in ${drift.theme}; no mockup`);
    const run = { ...options, browser, packet, sides, url: new URL(drift.address, app).href };
    for (const width of packet.widths) await driftAt(run, width);
  } finally {
    await Promise.all(sides.map((side) => side.context.close()));
    await browser.close();
  }
}

/** One width: drawn in the asked theme, drift proved, and no sideways scroll. */
async function driftAt(run: Run, width: number): Promise<void> {
  const { app, session, drift, mask, out, say, browser, packet, sides, url } = run;
  const name = `${drift.label}@${width}-${drift.theme}`;
  const side = await openSide(browser, packet, width, {
    app,
    session,
    colorScheme: drift.theme,
  });
  sides.push(side);
  const page = await load(side, packet, url);
  const asked = await page.evaluate(
    (theme) => matchMedia(`(prefers-color-scheme: ${theme})`).matches,
    drift.theme,
  );
  if (!asked) say(`FAIL ${name}: the page was not drawn in ${drift.theme}`, true);
  const base = await shoot(page, name, regions, mask);
  for (const shot of base) writeFileSync(`${out}/${fileOf(shot.name)}.app.png`, shot.png);
  if (drift.theme === 'dark') await notAsLight(run, width, name, base);
  await proveDrift(
    page,
    name,
    { regions, mask, base },
    { control: drift.control, token: drift.token, bites: 'page' },
    say,
  );
  const overflow = overflowOf(await page.evaluate(scrollMetrics));
  say(
    overflow === 0
      ? `ok ${name}: no sideways scroll`
      : `FAIL ${name}: scrolls sideways by ${overflow} px`,
    overflow > 0,
  );
  await page.close();
  if (side.unresolved.size > 0) {
    say(`FAIL ${name}: unresolved ${[...side.unresolved].join(' ')}`, true);
  }
}

/** A page with no dark theme draws the same in either scheme: that is not dark drift. */
async function notAsLight(run: Run, width: number, name: string, base: Shot[]): Promise<void> {
  const { app, session, mask, say, browser, packet, sides, url } = run;
  const light = await openSide(browser, packet, width, {
    app,
    session,
    colorScheme: 'light',
  });
  sides.push(light);
  const lightPage = await load(light, packet, url);
  const [drawn] = await shoot(lightPage, `${name}-as-light`, regions, mask);
  await lightPage.close();
  const same = comparePng(name, drawn?.png ?? Buffer.alloc(0), base[0]?.png ?? Buffer.alloc(0));
  say(
    same.pass
      ? `FAIL ${name}: draws the same as light; the page has no dark theme`
      : `ok ${name}: drawn in dark, not as light`,
    same.pass,
  );
}

const fileOf = (capture: string): string => capture.replaceAll(/[^\w@.-]/gu, '_');
