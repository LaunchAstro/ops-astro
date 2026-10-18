// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- units and their steps run one at a time,
   in order: each unit is one film, and a film shows one step after the next */
//
// The owner-check recordings for stage 1, Foundation (ops-astro#1747): each
// unit's "the owner's check passes" steps, from the owner checks issue
// (ops-astro#1750), clicked through in the app and filmed, one film per unit
// named with the build stamp.
//
//   node tests/visual/owner-checks.ts [--out DIR] [--unit U06]
//
//   OWNER_CHECK_OWNER_EMAIL=… OWNER_CHECK_OWNER_PASSWORD=… OWNER_CHECK_BUSINESS=…
//   [OWNER_CHECK_TEAMMATE_EMAIL=… OWNER_CHECK_TEAMMATE_PASSWORD=…] node tests/visual/owner-checks.ts
//   node tests/visual/owner-checks.ts --local
//
// The films are of the deployed made-up build on app.opsastro.com
// (owner-checks-source.ts), each signed in first with the made-up owner login
// from the environment; a missing login makes the film's steps red, never
// skipped. With --local the app is served from source over the made-up reads
// and session, as the width-and-theme harness does, for working on the steps.
// A step that cannot be shown in any film (a production alert or drill
// receipt, the private mockup, a client record the made-up data lacks)
// prints `not here` with what it waits on; a step whose screen is wrong, or
// whose login is missing, prints `red`.
// The films, `pack.json` and the phone page `index.html` land in DIR
// (default .local/evidence/owner-checks, gitignored).

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContextOptions, Page } from 'playwright';
import { launchChromium } from '../support/chromium.ts';
import { BUILD_SELECTOR } from '../browser/served-build.ts';
import { madeUpSession, serveApp } from './app-pages.ts';
import { load, openSide, type Side } from './capture.ts';
import { answerMadeUp } from './made-up-api.ts';
import { ACCESS } from './owner-checks-access.ts';
import { FOUNDATION } from './owner-checks-foundation.ts';
import { renderPack, stepLine, type StepResult, type UnitResult } from './owner-checks-report.ts';
import { SHELL } from './owner-checks-shell.ts';
import { DEPLOYED, loginOf, sourceOf } from './owner-checks-source.ts';
import {
  BEAT,
  caption,
  go,
  LAPTOP,
  Missed,
  signIn,
  type Check,
  type Ctx,
} from './owner-checks-steps.ts';
import { fetchAssets, MODE, readAssets, readPacket, type Packet } from './packet.ts';

const args = process.argv.slice(2);
const option = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};
const out =
  option('--out') ?? new URL('../../.local/evidence/owner-checks', import.meta.url).pathname;
const only = option('--unit');

const CHECKS: readonly Check[] = [...FOUNDATION, ...SHELL, ...ACCESS];

/**
 * The browser as `openSide` uses it, with each context it opens filmed. The
 * harness's own side (fonts, the app's origin, the made-up session) is kept
 * whole; only the film is added.
 */
function filming(
  browser: Browser,
  recordVideo: NonNullable<BrowserContextOptions['recordVideo']>,
): Browser {
  const newContext = async (options?: BrowserContextOptions) =>
    await browser.newContext({ ...options, recordVideo });
  return new Proxy(browser, {
    get: (target, key, receiver) =>
      key === 'newContext' ? newContext : Reflect.get(target, key, receiver),
  });
}

/** A film's page: the deployed build signed in as the made-up owner, or the local copy. */
async function opened(
  browser: Browser,
  packet: Packet,
  at: Ctx,
  session: string | undefined,
  check: Check,
): Promise<{ page: Page; close: () => Promise<void>; signedIn: StepResult | undefined }> {
  const video = { dir: join(out, '.raw'), size: { width: check.width, height: packet.height } };
  const colorScheme = check.theme ?? 'light';
  if (session !== undefined) {
    const side: Side = await openSide(filming(browser, video), packet, check.width, {
      app: at.app,
      session,
      colorScheme,
    });
    await answerMadeUp(side.context);
    const page = await load(side, packet, new URL(check.start, at.app).href);
    return { page, close: () => side.context.close(), signedIn: undefined };
  }
  const context = await browser.newContext({
    viewport: { width: check.width, height: packet.height },
    colorScheme,
    reducedMotion: 'reduce',
    locale: 'en-AU',
    timezoneId: 'Australia/Brisbane',
    recordVideo: video,
  });
  const page = await context.newPage();
  const step = 'Sign in as the made-up owner';
  const login = loginOf('OWNER');
  const outcome = await (async () => {
    if (login === undefined) throw new Error('no made-up owner login in OWNER_CHECK_OWNER_EMAIL');
    await signIn(page, at, login);
    await page.waitForURL((url) => url.pathname !== '/sign-in', { timeout: 15_000 });
    await go(page, at, check.start);
  })().then(
    () => ({ kind: 'ok' }) as const,
    (error: unknown) => ({ kind: 'red', why: firstLine(error) }) as const,
  );
  return { page, close: () => context.close(), signedIn: { step, outcome } };
}

const firstLine = (error: unknown): string =>
  error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);

async function film(
  browser: Browser,
  packet: Packet,
  at: Ctx,
  session: string | undefined,
  check: Check,
): Promise<UnitResult> {
  const { page, close: closeFilm, signedIn } = await opened(browser, packet, at, session, check);
  const steps: StepResult[] = signedIn === undefined ? [] : [signedIn];
  for (const [step, act] of check.steps) {
    if (signedIn !== undefined && signedIn.outcome.kind !== 'ok') {
      steps.push({ step, outcome: { kind: 'red', why: 'not signed in as the made-up owner' } });
      continue;
    }
    await caption(page, `${check.unit}: ${step}`);
    await page.waitForTimeout(BEAT);
    const outcome = await act(page, at).then(
      () => ({ kind: 'ok' }) as const,
      (error: unknown) =>
        error instanceof Missed && error.kind === 'not here'
          ? ({ kind: 'not here', why: error.message } as const)
          : ({
              kind: 'red',
              why: firstLine(error),
            } as const),
    );
    steps.push({ step, outcome });
    await caption(page, `${check.unit}: ${stepLine({ step, outcome })}`);
    await page.waitForTimeout(BEAT);
  }
  const raw = page.video();
  await closeFilm();
  const name = `${check.unit.replaceAll(/[^A-Z0-9]+/gu, '-').replace(/-$/u, '')}-${at.stamp}.webm`;
  if (raw !== null) renameSync(await raw.path(), join(out, name));
  return {
    unit: check.unit,
    issue: check.issue,
    title: check.title,
    video: raw === null ? undefined : name,
    steps,
  };
}

mkdirSync(out, { recursive: true });
const packet = readPacket();
await fetchAssets(readAssets(), packet);
const browser = await launchChromium(MODE);
const source = sourceOf(args);
const local = source.kind === 'local' ? await serveApp() : undefined;
const app = local === undefined ? DEPLOYED : local.app;
try {
  const session = local === undefined ? undefined : madeUpSession(local.app, join(out, '.session'));
  const probe =
    session === undefined
      ? { context: await browser.newContext() }
      : await openSide(browser, packet, LAPTOP, { app, session });
  if (session !== undefined) await answerMadeUp(probe.context);
  const first = await probe.context.newPage();
  await first.goto(new URL(session === undefined ? '/sign-in' : '/projects/', app).href);
  const stamp =
    (await first.locator(BUILD_SELECTOR).first().getAttribute('data-build')) ?? 'unstamped';
  await probe.context.close();
  const units: UnitResult[] = [];
  for (const check of CHECKS.filter((c) => only === undefined || c.unit.includes(only))) {
    const result = await film(browser, packet, { app, stamp }, session, check);
    units.push(result);
    console.log(`${result.unit}: ${result.video ?? 'no film'}`);
    for (const s of result.steps) console.log(`  ${stepLine(s)}`);
  }
  const pack = {
    stamp,
    made: new Date().toISOString(),
    source: local === undefined ? DEPLOYED.host : 'a local copy of the app',
    units,
  };
  writeFileSync(join(out, 'pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
  writeFileSync(join(out, 'index.html'), renderPack(pack));
  console.log(`owner checks: ${out}/index.html (build ${stamp})`);
} finally {
  await browser.close();
  await local?.close();
}
