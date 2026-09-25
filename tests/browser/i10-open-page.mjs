// SPDX-License-Identifier: AGPL-3.0-only
//
// I10/I11 on an open page, revoked through the owning route.
//
// N6 (`n6-revocation.mjs`) revokes through the internal `revokeGrant`. This
// file revokes the way a grant manager does: ada signs in to GoTrue and calls
// `grant.revoke` over HTTP on the running API, while the reader's task page
// stays mounted. The reader is a member whose only authority is one record
// grant, issued by `shareRecord`, the owning setup function, so the revocation
// is the whole difference between what the page may and may not show.
//
// Three rows, in the order N6 uses:
//   1. the open page, next fetch after `grant.revoke`: `denied`, no task content;
//   2. an authorised response taken from the API before the revocation, held at
//      the network and released after the denial, cannot restore it;
//   3. a later press still reads denied.
//
// R4, the external party on the same path, has rows of its own in
// `r4-shared-page.mjs`, which borrows this file's sign-in, call and share
// helpers so the two groups revoke the same way.
//
// Run: WEB_URL=... API_URL=... SHOT_DIR=... node tests/browser/i10-open-page.mjs

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { connect, connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import {
  API,
  VIEWPORT,
  WEB,
  closeQuietly,
  fromEnvFile,
  record,
  root,
  shot,
  signIn,
  standaloneStatus,
  users,
} from './harness.mjs';
import { personOfLogin } from './n6-revocation.mjs';

const step = (what) => {
  process.stderr.write(`i10: ${what}\n`);
};

const isTaskRead = (url) => url.pathname.endsWith('/task/read');

/** The task region's own denial; the page also reads people, which can refuse too. */
const taskDenial = (page) => page.locator('[data-outcome="denied"]', { hasText: 'this task' });

/** GoTrue's address, from the same gitignored file the API reads. */
function gotrueUrl() {
  if (process.env.GOTRUE_URL) return process.env.GOTRUE_URL;
  for (const line of readFileSync(`${root}.local/auth.env`, 'utf8').split('\n')) {
    const match = /^GOTRUE_URL=(.+)$/u.exec(line.trim());
    if (match) return match[1];
  }
  return 'http://127.0.0.1:54391';
}

/** A real sign-in: GoTrue's password grant, the one the web's form makes. */
export async function tokenOf(email) {
  const user = users.find((entry) => entry.email === email);
  const response = await fetch(`${gotrueUrl()}/token?grant_type=password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: user?.password }),
  });
  if (!response.ok) throw new Error(`GoTrue refused ${email}: ${String(response.status)}`);
  return (await response.json()).access_token;
}

/** One call to the running API, as the web's client makes it. */
export async function callApi(token, operation, body) {
  const response = await fetch(`${API}/api/b/alpha/${operation.replace('.', '/')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** Person and acting identity behind a synthetic login. */
export async function identityOf(admin, businessId, email) {
  const subject = users.find((entry) => entry.email === email)?.subject;
  const personId = await personOfLogin(admin, businessId, 'supabase', subject);
  const rows = await admin.execute(
    'select id from public.actors where business_id = $1 and person_id = $2 limit 1',
    [businessId, personId],
  );
  return { personId, actorId: rows[0]?.id };
}

/** ada creates a task over HTTP and shares it with one person through `shareRecord`. */
export async function sharedTask(given, email, title) {
  const { database, admin, alpha, adaToken } = given;
  const made = await callApi(adaToken, 'task.create', {
    operationId: randomUUID(),
    fields: { title },
  });
  if (made.status !== 200) throw new Error(`task.create answered ${String(made.status)}`);
  const recordId = String(made.body.recordId);
  const ada = await identityOf(admin, alpha, 'ada@alpha.local');
  const reader = await identityOf(admin, alpha, email);
  const issued = await database.withBusiness(alpha, (tx) =>
    shareRecord(tx, ada, { collection: 'task', recordId, personId: reader.personId }),
  );
  if (!issued.ok) throw new Error(`shareRecord refused ${issued.refusal.code}`);
  return { recordId, grantId: issued.value };
}

/**
 * The three rows, for the member on a record grant.
 *
 * `run` is the checklist runner's: its browser, pools and business.
 */
export async function casesI10OpenPage(run) {
  const { browser, database, admin, alpha } = run;
  const email = 'noah@alpha.local';
  const title = `I10 open page ${new Date().toISOString()}`;
  const adaToken = await tokenOf('ada@alpha.local');
  const { recordId, grantId } = await sharedTask(
    { database, admin, alpha, adaToken },
    email,
    title,
  );

  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    step(`${email} opens the shared task`);
    await signIn(page, email, 'alpha');
    await page.goto(`${WEB}/task/${recordId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-task]', { timeout: 20_000 });
    await page.waitForSelector('[data-refresh="task"]', { timeout: 20_000 });
    const titleShown = (await page.locator('body').innerText()).includes(title);
    const openShot = await shot(page, 'I10-open-authorised');

    // Press one is held at the network after the API answered it, with the
    // grant still live: the authorised response a late arrival would carry.
    let held;
    let heldBody;
    let seen = 0;
    await page.route(isTaskRead, async (route) => {
      seen += 1;
      if (seen === 1) {
        const response = await route.fetch();
        heldBody = await response.text();
        held = route;
        return;
      }
      await route.continue();
    });
    step('press one: an authorised read, held');
    await page.click('[data-refresh="task"]');
    await page.waitForSelector('[data-outcome="loading"]', { timeout: 10_000 });
    await page.waitForFunction(() => document.querySelector('[data-refresh="task"]') !== null);

    step('ada revokes through grant.revoke over HTTP');
    const revoked = await callApi(adaToken, 'grant.revoke', { operationId: randomUUID(), grantId });

    step('press two: the next fetch');
    await page.click('[data-refresh="task"]');
    await taskDenial(page).first().waitFor({ timeout: 20_000 });
    const deniedText = await taskDenial(page).first().innerText();
    const afterDenial = await page.locator('body').innerText();
    record({
      case: 'I10 open page, grant.revoke',
      action:
        `${email} held /task/${recordId} open on a record grant from shareRecord; ada ` +
        `revoked it through grant.revoke over HTTP on ${API}; Refresh was pressed`,
      observed:
        `grant.revoke answered ${String(revoked.status)}; title shown before: ` +
        `${String(titleShown)}; the page drew data-outcome="denied" quoting ` +
        `${JSON.stringify(deniedText.replaceAll(/\s+/gu, ' ').slice(0, 90))}; ` +
        `${String(await page.locator('[data-task]').count())} task region(s), title ` +
        `${afterDenial.includes(title) ? 'STILL' : 'not'} on the page`,
      ok:
        titleShown &&
        revoked.status === 200 &&
        /SCOPE_NOT_GRANTED/u.test(deniedText) &&
        (await page.locator('[data-task]').count()) === 0 &&
        !afterDenial.includes(title),
      shot: await shot(page, 'I10-denied-after-grant-revoke'),
      extra: { authorised: openShot },
    });

    step('releasing the held authorised response');
    const heldWasAuthorised = heldBody !== undefined && heldBody.includes(title);
    if (held !== undefined) {
      await held.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: heldBody,
      });
    }
    // The released response is delivered; give it the chance to draw, as N6 does.
    await page.waitForTimeout(1500);
    const deniedAfter = (await taskDenial(page).count()) > 0;
    const afterRelease = await page.locator('body').innerText();
    record({
      case: 'I10 older authorised cannot restore',
      action:
        'an authorised task.read taken before grant.revoke was held at the network and ' +
        'released to the same mounted page after the denial',
      observed:
        `held response ${heldWasAuthorised ? 'carried the title' : 'did NOT carry the title'}; ` +
        `after release the task denial is ${deniedAfter ? 'still drawn' : 'GONE'}, title ` +
        `${afterRelease.includes(title) ? 'STILL' : 'not'} on the page`,
      ok: heldWasAuthorised && deniedAfter && !afterRelease.includes(title),
      shot: await shot(page, 'I10-older-response-refused'),
    });

    await page.unroute(isTaskRead);
    step('press three: a later read');
    const answered = page.waitForResponse((response) => isTaskRead(new URL(response.url())));
    await page.click('[data-refresh="task"]');
    const later = await answered;
    await page.waitForSelector('[data-outcome="loading"]', { state: 'detached', timeout: 20_000 });
    const deniedLater = (await taskDenial(page).count()) > 0;
    const afterLater = await page.locator('body').innerText();
    record({
      case: 'I10 a later read stays denied',
      action: 'Refresh pressed again after the release, with no hold',
      observed:
        `task.read answered ${String(later.status())}; the task denial is ` +
        `${deniedLater ? 'drawn' : 'NOT drawn'}, title ${afterLater.includes(title) ? 'STILL' : 'not'} shown`,
      ok: later.status() === 403 && deniedLater && !afterLater.includes(title),
      shot: await shot(page, 'I10-later-read-denied'),
    });
  } finally {
    await context.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.launch();
  const database = connect(fromEnvFile('DATABASE_URL'), { source: 'i10-open-page' });
  const admin = connectAsAdmin(fromEnvFile('DATABASE_ADMIN_URL'), { source: 'i10-open-page' });
  let status = 1;
  try {
    const alpha = (
      await admin.execute('select id from public.businesses where key = $1', ['alpha'])
    )[0]?.id;
    const run = { browser, database, admin, alpha };
    try {
      await casesI10OpenPage(run);
    } catch (error) {
      record({
        case: 'I10 run',
        action: 'the group',
        observed: String(error).slice(0, 300),
        ok: false,
      });
    }
    status = standaloneStatus('I10 open page', [
      'I10 open page, grant.revoke',
      'I10 older authorised cannot restore',
      'I10 a later read stays denied',
    ]);
  } finally {
    await browser.close();
    await closeQuietly(database);
    await closeQuietly(admin);
  }
  process.exit(status);
}
