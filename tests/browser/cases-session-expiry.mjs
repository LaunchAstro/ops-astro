// SPDX-License-Identifier: AGPL-3.0-only
//
// SX1-SX3: the hour ran out, and there is a way back in.
//
// A local GoTrue access token lives for one hour. The API answers a missing, an
// expired and an unverifiable bearer identically -- HTTP 401 with
// `AUTH_UNKNOWN_LOGIN` -- so this group does not wait an hour: it replaces the
// stored token with a string the server cannot verify, which is the same answer
// by the API's own rule (`docs/local/API.md`). What is being proven is the
// application's half, and the application cannot tell the two apart either.
//
// **Nothing here writes.** No task is created, edited or moved; the group signs
// in, reads a task the board already carries, breaks its own session in the
// page, and signs in again. The only state it leaves behind is a session in its
// own browser context.
//
// Run: node tests/browser/cases-session-expiry.mjs  (or through slice-acceptance)

import { chromium } from 'playwright';
import { VIEWPORT, WEB, passwordOf, record, shot, signIn, standaloneStatus } from './harness.mjs';

const NOTICE = '[data-reason="session-ended"]';
/** The rows a standalone run has to have passed before it may exit zero. */
const REQUIRED = ['SX1', 'SX2', 'SX3'];
const UNVERIFIABLE = 'not-a-token-this-server-can-verify';

export async function casesSessionExpiry(run) {
  // Its own context, like N1-N2 and B6-B7. This group signs in from scratch and
  // then breaks the session it is holding; on the shared page it would land on
  // `/projects/` instead of the sign-in form -- the page still holds the
  // previous group's session -- and would leave a broken token behind for the
  // groups that follow. A context of its own is both the fix and the isolation.
  const { browser } = run;
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    await sessionExpiry(page);
  } finally {
    await context.close();
  }
}

async function sessionExpiry(page) {
  await signIn(page, 'ada@alpha.local', 'alpha');

  // A task the board already carries. This group reads; it does not make one.
  await page.goto(`${WEB}/projects/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a.cbd__nm, [data-outcome]', { timeout: 15_000 });
  const address = await page.getAttribute('a.cbd__nm', 'href');
  if (address === null) {
    record({
      case: 'SX1 an unverifiable token on a task address',
      action: 'ada opened the board looking for a task to reload',
      observed: 'the board drew no task row, so there was no address to reload',
      ok: false,
      shot: await shot(page, 'SX-no-board-row'),
    });
    return;
  }

  // The hour running out, expressed the way the server experiences it: the
  // token in the tab's own session store is no longer one it can vouch for.
  await page.evaluate((token) => {
    const held = JSON.parse(sessionStorage.getItem('ops-astro.session'));
    sessionStorage.setItem('ops-astro.session', JSON.stringify({ ...held, token }));
  }, UNVERIFIABLE);

  await page.goto(`${WEB}${address}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.location.pathname === '/sign-in' || document.querySelector('[data-revision]'),
    { timeout: 15_000 },
  );
  const landedOn = await page.evaluate(() => window.location.pathname);
  const noticed = (await page.locator(NOTICE).count()) === 1;
  const said = noticed ? await page.locator(NOTICE).innerText() : '';
  record({
    case: 'SX1 an ended session reaches sign-in',
    action: `ada reloaded ${address} with a token the API cannot verify`,
    observed: `landed on ${landedOn} with ${noticed ? 'the' : 'no'} session-ended notice`,
    ok: landedOn === '/sign-in' && noticed,
    shot: await shot(page, 'SX1-session-ended'),
  });

  // The notice quotes the server rather than guessing, and the address the
  // person was on outlives a reload of the screen they were put on.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#signin-email', { timeout: 15_000 });
  const remembered = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('ops-astro.return-to') ?? 'null'),
  );
  const quoted = said.includes('AUTH_UNKNOWN_LOGIN');
  record({
    case: "SX2 the server's word, and the address kept",
    action: 'read the notice, then reloaded /sign-in',
    observed: `notice quoted ${quoted ? 'AUTH_UNKNOWN_LOGIN' : `neither code: "${said}"`}; after the reload sessionStorage remembers ${JSON.stringify(remembered?.address)}`,
    ok: quoted && remembered?.address === address,
    shot: await shot(page, 'SX2-address-remembered'),
  });

  // And signing in again puts them back on it, drawing the record itself.
  await page.fill('#signin-email', 'ada@alpha.local');
  await page.fill('#signin-password', passwordOf('ada@alpha.local'));
  await page.selectOption('#signin-business', 'alpha');
  await page.click('form.signin__form button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname !== '/sign-in', { timeout: 15_000 });
  await page.waitForSelector('[data-revision]', { timeout: 15_000 }).catch(() => undefined);
  const backOn = await page.evaluate(() => window.location.pathname);
  const drawing = (await page.locator('[data-revision]').count()) > 0;
  const stillRemembered = await page.evaluate(() => sessionStorage.getItem('ops-astro.return-to'));
  record({
    case: 'SX3 signing in returns to the same task',
    action: 'ada signed in again from the notice',
    observed: `landed on ${backOn}, ${drawing ? 'drawing the task' : 'drawing no task'}, and the remembered address is ${stillRemembered === null ? 'spent' : 'still held'}`,
    ok: backOn === address && drawing && stillRemembered === null,
    shot: await shot(page, 'SX3-back-on-the-task'),
  });
}

// ------------------------------------------------------------------ standalone

// A zero exit from here means every SX row above passed, and nothing else.
// The caught-error path records a failed row like any other, so a timeout that
// never reached SX3 leaves both a FAIL row and an absent required row, and the
// status says so twice rather than staying silent.
if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.launch();
  try {
    await casesSessionExpiry({ browser });
  } catch (error) {
    record({
      case: 'SX run',
      action: 'the group itself',
      observed: `threw: ${String(error).slice(0, 400)}`,
      ok: false,
    });
  } finally {
    await browser.close();
  }
  process.exitCode = standaloneStatus('session expiry', REQUIRED);
}
