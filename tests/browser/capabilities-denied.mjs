// SPDX-License-Identifier: AGPL-3.0-only
//
// CD: `session.capabilities` refused, drawn as the product's denied state.
//
// Minimum contract 8.2 case 3 (ledger I05): a member holding no grant is
// refused `SCOPE_NOT_GRANTED` by every operation, and a denied read is never a
// success with an empty list. `noah` is that member in the seed (`grants: []`).
// The mounted app reads capabilities on /settings, so this is where the refusal
// has to arrive as denied: not an empty list, not a crash, and not what the
// previous person in the same tab was shown.
//
// CD1 is the control: `mia` holds grants, her read answers, and the screen
// draws what it concluded from them. CD2 signs `noah` in on the same tab and
// opens the same screen: the wire answer is a 403 refusal, the capability
// block is `denied` with the code on the page, both controls are closed, no
// write goes out, and mia's conclusion (`settings:manage` missing) is gone.
//
// Standalone: `WEB_URL=… API_URL=… SHOT_DIR=… node tests/browser/capabilities-denied.mjs`.

import { chromium } from 'playwright';
import { VIEWPORT, WEB, record, shot, signIn, standaloneStatus } from './harness.mjs';

const REQUIRED = ['CD1', 'CD2'];
const CAPS = '[data-settings="capabilities"]';
const BECAUSE = '[data-settings="capabilities-because"]';
const SAVE = '[data-settings="save-four-eyes"]';
const SIGN_OFF = '[data-settings="save-sign-off"]';

async function signInAs(page, email) {
  if (!page.url().startsWith(WEB)) await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    sessionStorage.clear();
  });
  await signIn(page, email, 'alpha');
}

/** Open /settings and wait for the capability read's own answer, with the wire's. */
async function openSettings(page) {
  const answered = page.waitForResponse(
    (response) => response.url().includes('/session/capabilities'),
    { timeout: 15_000 },
  );
  await page.goto(`${WEB}/settings`, { waitUntil: 'domcontentloaded' });
  const response = await answered;
  const body = await response.json().catch(() => ({}));
  await page.waitForFunction(
    (selector) => {
      const outcome = document.querySelector(selector)?.dataset.outcome;
      return outcome !== undefined && outcome !== 'loading';
    },
    CAPS,
    { timeout: 15_000 },
  );
  const outcome = await page.locator(CAPS).getAttribute('data-outcome');
  const said = await page
    .locator(BECAUSE)
    .allInnerTexts()
    .then((texts) => texts.join(' '))
    .catch(() => '');
  return { status: response.status(), body, outcome, said };
}

export async function casesCapabilitiesDenied(run) {
  const context = await run.browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const sent = [];
  page.on('request', (request) => {
    if (request.url().includes('/settings/set_')) sent.push(request.url());
  });
  try {
    await signInAs(page, 'mia@alpha.local');
    const mia = await openSettings(page);
    record({
      case: 'CD1 a granted member is answered her own capabilities',
      action: 'mia opened /settings',
      observed:
        `the read answered ${String(mia.status)} with ` +
        `${Array.isArray(mia.body.grants) ? String(mia.body.grants.length) : 'no'} pair(s); ` +
        `the block is "${String(mia.outcome)}" and says "${mia.said.slice(0, 80)}"`,
      ok:
        mia.status === 200 &&
        Array.isArray(mia.body.grants) &&
        mia.body.grants.length > 0 &&
        mia.outcome === 'ready' &&
        mia.said.includes('settings:manage'),
      shot: await shot(page, 'CD1-mia-capabilities-ready'),
    });

    await signInAs(page, 'noah@alpha.local');
    const noah = await openSettings(page);
    await page.waitForSelector(SAVE, { timeout: 15_000 });
    const closed =
      (await page.locator(SAVE).isDisabled()) && (await page.locator(SIGN_OFF).isDisabled());
    await page.click(SAVE, { force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
    record({
      case: 'CD2 a member holding nothing is shown denied, not empty',
      action: 'noah opened /settings on the tab mia had used, and pressed save',
      observed:
        `the read answered ${String(noah.status)} ${String(noah.body.code)} ` +
        `(grants ${noah.body.grants === undefined ? 'absent' : 'present'}); the block is ` +
        `"${String(noah.outcome)}" and says "${noah.said.slice(0, 120)}"; the controls are ` +
        `${closed ? 'closed' : 'open'} and ${String(sent.length)} write(s) were sent`,
      ok:
        noah.status === 403 &&
        noah.body.refused === true &&
        noah.body.code === 'SCOPE_NOT_GRANTED' &&
        noah.body.grants === undefined &&
        noah.outcome === 'denied' &&
        noah.said.includes('SCOPE_NOT_GRANTED') &&
        noah.said.includes('You hold no grant') &&
        // mia's conclusion from her own grants is not carried onto noah's page.
        !noah.said.includes('settings:manage') &&
        closed &&
        sent.length === 0,
      shot: await shot(page, 'CD2-noah-capabilities-denied'),
    });
  } finally {
    await context.close();
  }
}

// ------------------------------------------------------------------ standalone

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.launch();
  const run = { browser, stamp: new Date().toISOString(), state: {} };
  try {
    await casesCapabilitiesDenied(run);
  } catch (error) {
    record({
      case: 'CD run',
      action: 'the group itself',
      observed: `threw: ${String(error).slice(0, 400)}`,
      ok: false,
    });
  } finally {
    await browser.close();
  }
  process.exitCode = standaloneStatus('capabilities denied', REQUIRED);
}
