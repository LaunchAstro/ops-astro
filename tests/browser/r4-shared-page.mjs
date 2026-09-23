// SPDX-License-Identifier: AGPL-3.0-only
//
// R4, the external party, on its shared task page, revoked through the owning
// route while the page is open.
//
// The external party holds no membership. Its only authority is one record
// grant issued by `shareRecord`, and its `task.read` answers `sharedTask`, the
// server's shared projection (`packages/core-records/src/reads/requests.ts`,
// `SharedTaskView`): the fields the catalogue marks `shared` and the client
// comments. The page draws that and nothing else. It never builds an internal
// task out of it and never fetches anything to fill it in.
//
// ada writes two comments on the task before sharing it: a client one, which
// is the content the external page must show, and an internal one, which it
// must never show. The internal title is also never on the page, because no
// task field is classified `shared` in this slice.
//
// Four rows, in I10's order:
//   1. the open page draws the shared view: the client comment, no internal
//      comment, no title, no control that writes;
//   2. the next fetch after `grant.revoke` draws the denied state and none of
//      the shared content;
//   3. an authorised response taken before the revocation, held at the network
//      and released after the denial, cannot restore it;
//   4. a later press still reads denied.
//
// Run: WEB_URL=... API_URL=... SHOT_DIR=... node tests/browser/r4-shared-page.mjs

import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { connect, connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import {
  API,
  VIEWPORT,
  WEB,
  closeQuietly,
  fromEnvFile,
  record,
  shot,
  signIn,
  standaloneStatus,
  users,
} from './harness.mjs';
import { callApi, sharedTask, tokenOf } from './i10-open-page.mjs';

const step = (what) => {
  process.stderr.write(`r4: ${what}\n`);
};

const isTaskRead = (url) => url.pathname.endsWith('/task/read');

/** The task region's own denial; any other region's refusal is not this row's. */
const taskDenial = (page) => page.locator('[data-outcome="denied"]', { hasText: 'this task' });

/** Anything a person could press or type into inside the task region. */
const CONTROLS = '[data-task] button, [data-task] input, [data-task] textarea, [data-task] select';

/** ada's two comments, posted over HTTP against the task's own revision. */
async function comment(adaToken, recordId, body, audience) {
  const read = await callApi(adaToken, 'task.read', { recordId });
  const posted = await callApi(adaToken, 'task.comment', {
    operationId: randomUUID(),
    recordId,
    body,
    audience,
    commentType: audience === 'client' ? 'client' : 'note',
    expectedRevision: read.body.task.revision,
  });
  if (posted.status !== 200) throw new Error(`task.comment answered ${String(posted.status)}`);
}

/**
 * The four rows, for the external party on a record grant.
 *
 * `run` is the checklist runner's: its browser, pools and business.
 */
export async function casesR4SharedPage(run) {
  const { browser, database, admin, alpha } = run;
  // The seed builds the external address rather than writing it; so does this.
  const email = users.find((user) => user.role === 'external')?.email;
  if (email === undefined) throw new Error('no role: external entry in synthetic-users.json');
  const stamp = new Date().toISOString();
  const title = `R4 internal title ${stamp}`;
  const client = `R4 client comment ${stamp}`;
  const internal = `R4 internal note ${stamp}`;
  const adaToken = await tokenOf('ada@alpha.local');
  const { recordId, grantId } = await sharedTask(
    { database, admin, alpha, adaToken },
    email,
    title,
  );
  await comment(adaToken, recordId, client, 'client');
  await comment(adaToken, recordId, internal, 'internal');

  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 160)));
  try {
    step(`${email} opens the shared task`);
    await signIn(page, email, 'alpha');
    const answered = page.waitForResponse((response) => isTaskRead(new URL(response.url())));
    await page.goto(`${WEB}/task/${recordId}`, { waitUntil: 'domcontentloaded' });
    const first = await answered;
    const firstBody = await first.text();
    // Either the shared region draws or nothing does; a blank page is the red.
    const drawn = await page
      .waitForSelector('[data-task-view="shared"]', { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    const openText = await page.locator('body').innerText();
    const controls = await page.locator(CONTROLS).count();
    record({
      case: 'R4 open shared task',
      action:
        `${email} opened /task/${recordId}, shared with it by shareRecord; ada had posted ` +
        'one client and one internal comment',
      observed:
        `task.read answered ${String(first.status())} with ` +
        `${firstBody.includes('"sharedTask"') ? 'sharedTask' : 'NO sharedTask'}; shared view ` +
        `${drawn ? 'drawn' : 'NOT drawn'}; client comment ${openText.includes(client) ? 'shown' : 'MISSING'}; ` +
        `internal note ${openText.includes(internal) ? 'SHOWN' : 'absent'}; title ` +
        `${openText.includes(title) ? 'SHOWN' : 'absent'}; ${String(controls)} control(s) in the ` +
        `task region; page errors ${JSON.stringify(errors)}`,
      ok:
        first.status() === 200 &&
        firstBody.includes('"sharedTask"') &&
        drawn &&
        openText.includes(client) &&
        !openText.includes(internal) &&
        !openText.includes(title) &&
        controls === 0 &&
        errors.length === 0,
      shot: await shot(page, drawn ? 'R4-open-shared' : 'R4-open-blank'),
    });
    if (!drawn) return;

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

    step('ada revokes through grant.revoke over HTTP');
    const revoked = await callApi(adaToken, 'grant.revoke', { operationId: randomUUID(), grantId });

    step('press two: the next fetch');
    await page.click('[data-refresh="task"]');
    await taskDenial(page).first().waitFor({ timeout: 20_000 });
    const deniedText = await taskDenial(page).first().innerText();
    const afterDenial = await page.locator('body').innerText();
    record({
      case: 'R4 denied after grant.revoke',
      action:
        `ada revoked the external party's grant through grant.revoke over HTTP on ${API} ` +
        'while its page was open; Refresh was pressed',
      observed:
        `grant.revoke answered ${String(revoked.status)}; the page drew data-outcome="denied" ` +
        `quoting ${JSON.stringify(deniedText.replaceAll(/\s+/gu, ' ').slice(0, 90))}; ` +
        `${String(await page.locator('[data-task]').count())} task region(s), client comment ` +
        `${afterDenial.includes(client) ? 'STILL' : 'not'} on the page`,
      ok:
        revoked.status === 200 &&
        (await page.locator('[data-task]').count()) === 0 &&
        !afterDenial.includes(client),
      shot: await shot(page, 'R4-denied-after-grant-revoke'),
    });

    step('releasing the held authorised response');
    const heldWasAuthorised = heldBody !== undefined && heldBody.includes(client);
    if (held !== undefined) {
      await held.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: heldBody,
      });
    }
    await page.waitForTimeout(1500);
    const deniedAfter = (await taskDenial(page).count()) > 0;
    const afterRelease = await page.locator('body').innerText();
    record({
      case: 'R4 older authorised cannot restore',
      action:
        'a shared task.read taken before grant.revoke was held at the network and released ' +
        'to the same mounted page after the denial',
      observed:
        `held response ${heldWasAuthorised ? 'carried the client comment' : 'did NOT carry it'}; ` +
        `after release the task denial is ${deniedAfter ? 'still drawn' : 'GONE'}, client ` +
        `comment ${afterRelease.includes(client) ? 'STILL' : 'not'} on the page`,
      ok: heldWasAuthorised && deniedAfter && !afterRelease.includes(client),
      shot: await shot(page, 'R4-older-response-refused'),
    });

    await page.unroute(isTaskRead);
    step('press three: a later read');
    const later = page.waitForResponse((response) => isTaskRead(new URL(response.url())));
    await page.click('[data-refresh="task"]');
    const laterResponse = await later;
    await page.waitForSelector('[data-outcome="loading"]', { state: 'detached', timeout: 20_000 });
    const deniedLater = (await taskDenial(page).count()) > 0;
    const afterLater = await page.locator('body').innerText();
    record({
      case: 'R4 a later read stays denied',
      action: 'Refresh pressed again after the release, with no hold',
      observed:
        `task.read answered ${String(laterResponse.status())}; the task denial is ` +
        `${deniedLater ? 'drawn' : 'NOT drawn'}, client comment ` +
        `${afterLater.includes(client) ? 'STILL' : 'not'} shown`,
      ok: laterResponse.status() >= 400 && deniedLater && !afterLater.includes(client),
      shot: await shot(page, 'R4-later-read-denied'),
    });
  } finally {
    await context.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.launch();
  const database = connect(fromEnvFile('DATABASE_URL'), { source: 'r4-shared-page' });
  const admin = connectAsAdmin(fromEnvFile('DATABASE_ADMIN_URL'), { source: 'r4-shared-page' });
  let status = 1;
  try {
    const alpha = (
      await admin.execute('select id from public.businesses where key = $1', ['alpha'])
    )[0]?.id;
    try {
      await casesR4SharedPage({ browser, database, admin, alpha });
    } catch (error) {
      record({
        case: 'R4 run',
        action: 'the group',
        observed: String(error).slice(0, 300),
        ok: false,
      });
    }
    status = standaloneStatus('R4 shared page', [
      'R4 open shared task',
      'R4 denied after grant.revoke',
      'R4 older authorised cannot restore',
      'R4 a later read stays denied',
    ]);
  } finally {
    await browser.close();
    await closeQuietly(database);
    await closeQuietly(admin);
  }
  process.exit(status);
}
