// SPDX-License-Identifier: AGPL-3.0-only
//
// ND1-ND3: `C58 no draft after session end`, in a real browser.
//
// The jsdom proof (`tests/surfaces/c58-no-draft-after-session-end.test.tsx`)
// stands in for the API and has no IndexedDB and no Cache Storage. This group
// is its browser leg: the real API and identity provider end the session, and
// then every store a Chromium tab has is read, those two included, with every
// cookie the browser context holds (HttpOnly ones too, which `document.cookie`
// cannot see).
//
// Each row opens a task in a context of its own, types a title and a comment
// that are never saved, and ends the session its way:
//
//   - ND1 access ended. Ada ends a person's access through the real
//     `access.end`. Their bearer still verifies, so the API answers their next
//     call 403 `AUTH_NO_MEMBERSHIP`. The person is ND1's own
//     (`c58-no-draft-world.mjs`), never a seeded one.
//   - ND2 the 12-hour limit. From the moment the session ends, the page's
//     calls carry its own token re-signed with its first sign-in 12 hours and
//     one second ago, so the API's absolute-limit check answers 401
//     `AUTH_SESSION_EXPIRED`. Nothing waits twelve hours; the answer is the
//     server's.
//   - ND3 signing out, from the top bar.
//
// Each ends on the sign-in page, which says the edit was not saved, with the
// title and comment canaries and the token in no store. ND2 and ND3 then sign
// in again and find the server's title and an empty comment box.
//
// ND1 issues grants and ends them, so like S it runs well behind N6.
//
// Run: node tests/browser/cases-c58-no-draft.mjs  (or through slice-acceptance)

import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { connect, connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import {
  VIEWPORT,
  WEB,
  closeQuietly,
  fromEnvFile,
  passwordOf,
  record,
  shot,
  signIn,
  standaloneStatus,
} from './harness.mjs';
import { callApi, tokenOf } from './i10-open-page.mjs';
import { pastTheLimit, signInAs, throwawayMember } from './c58-no-draft-world.mjs';

const REQUIRED = ['ND1', 'ND2', 'ND3'];
const SESSION_KEY = 'ops-astro.session';
const TITLE_CANARY = 'c58-browser-unsaved-title-canary';
const COMMENT_CANARY = 'c58-browser-unsaved-comment-canary';

export async function casesNoDraft(run) {
  const { browser, database, admin, alpha, stamp } = run;
  const adaToken = await tokenOf('ada@alpha.local');
  const title = `ND ${stamp}`;
  const made = await callApi(adaToken, 'task.create', {
    operationId: randomUUID(),
    fields: { title },
  });
  if (made.status !== 200) throw new Error(`task.create answered ${String(made.status)}`);
  const task = { recordId: String(made.body.recordId), title };

  const leaver = await throwawayMember({ database, admin, alpha, stamp });
  await inContext(browser, (page) => accessEnded(page, task, leaver, adaToken));
  await inContext(browser, (page) => twelveHours(page, task));
  await inContext(browser, (page) => signedOut(page, task));
}

async function inContext(browser, body) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    await body(await context.newPage());
  } finally {
    await context.close();
  }
}

// ------------------------------------------------------------------- the rows

async function accessEnded(page, task, leaver, adaToken) {
  await signInAs(page, leaver.email, leaver.password);
  const token = await openAndType(page, task);
  const ended = await callApi(adaToken, 'access.end', {
    operationId: randomUUID(),
    holderId: leaver.personId,
  });
  // The page may be signed out before the press: a live refresh after the act
  // meets the same refusal. Either way the edit was never saved.
  const pressed = await page
    .click('button[data-draft-resolve="save"]', { timeout: 5000 })
    .then(() => 'then they pressed save')
    .catch(() => 'and the tab left the edit before save could be pressed');
  const after = await afterTheEnd(page, 'session-ended', token);
  record({
    case: 'ND1 access ended mid-edit, no draft',
    action: `ada ended the person's access (access.end ${String(ended.status)}), ${pressed}`,
    observed: after.observed,
    ok: ended.status === 200 && after.ok && after.notice.includes('AUTH_NO_MEMBERSHIP'),
    shot: await shot(page, 'ND1-access-ended'),
  });
}

async function twelveHours(page, task) {
  await signIn(page, 'mia@alpha.local', 'alpha');
  const token = await openAndType(page, task);
  const aged = await pastTheLimit(token);
  await page.route('**/api/**', (route) =>
    route.continue({
      headers: { ...route.request().headers(), authorization: `Bearer ${aged}` },
    }),
  );
  await page.click('button[data-draft-resolve="save"]');
  const after = await afterTheEnd(page, 'session-ended', token, aged);
  await page.unroute('**/api/**');
  const back = await signBackIn(page, task, 'mia@alpha.local', after);
  record({
    case: 'ND2 the 12-hour limit mid-edit, no draft',
    action: "mia pressed save with the page's token past its first sign-in by 12h and 1s",
    observed: `${after.observed}; signed in again: ${back.observed}`,
    ok: after.ok && after.notice.includes('AUTH_SESSION_EXPIRED') && back.ok,
    shot: await shot(page, 'ND2-twelve-hours'),
  });
}

async function signedOut(page, task) {
  await signIn(page, 'mia@alpha.local', 'alpha');
  const token = await openAndType(page, task);
  await page.click('.topbar__who button');
  const after = await afterTheEnd(page, 'signed-out', token);
  const back = await signBackIn(page, task, 'mia@alpha.local', after);
  record({
    case: 'ND3 signing out mid-edit, no draft',
    action: 'mia signed out from the top bar with the edit unsaved',
    observed: `${after.observed}; signed in again: ${back.observed}`,
    ok: after.ok && back.ok,
    shot: await shot(page, 'ND3-signed-out'),
  });
}

// ------------------------------------------------------------------ the steps

/** Open the task, type the two canaries, and return the tab's token. */
async function openAndType(page, task) {
  await page.goto(`${WEB}/task/${task.recordId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#task-title', { timeout: 15_000 });
  await page.fill('#task-title', TITLE_CANARY);
  await page.fill('#comment-body', COMMENT_CANARY);
  await page.waitForSelector('button[data-draft-resolve="save"]', { timeout: 15_000 });
  return await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).token, SESSION_KEY);
}

/**
 * Where the tab is once the session has ended, and what every store holds.
 * `secrets` are the tokens that must be in none of them.
 */
async function afterTheEnd(page, reason, ...secrets) {
  await page.waitForSelector('#signin-email', { timeout: 15_000 }).catch(() => false);
  const path = await page.evaluate(() => window.location.pathname);
  const notice = page.locator(`[data-reason="${reason}"]`);
  const said = (await notice.count()) === 1 ? await notice.innerText() : '';
  const stores = await everyStore(page);
  const found = [
    [TITLE_CANARY, 'the title'],
    [COMMENT_CANARY, 'the comment'],
    ...secrets.map((secret) => [secret, 'a token']),
  ]
    .filter(([value]) => stores.text.includes(value))
    .map(([, name]) => name);
  const shown = said === '' ? `no ${reason} notice` : `notice "${oneLine(said)}"`;
  const held = found.length === 0 ? 'no canary or token in any' : `FOUND ${found.join(', ')}`;
  return {
    ok: path === '/sign-in' && said.includes('was not saved') && found.length === 0,
    path,
    notice: said,
    observed: `on ${path}, ${shown}; read ${stores.summary}; ${held}`,
  };
}

const oneLine = (text) => text.replaceAll(/\s+/gu, ' ').slice(0, 120);

/** Sign in again and reopen the task: the server's title, an empty comment box. */
async function signBackIn(page, task, email, after) {
  if (after.path !== '/sign-in') return { ok: false, observed: 'not tried, the tab never left' };
  await page.fill('#signin-email', email);
  await page.fill('#signin-password', passwordOf(email));
  await page.selectOption('#signin-business', 'alpha');
  await page.click('form.signin__form button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname !== '/sign-in', { timeout: 15_000 });
  await page.goto(`${WEB}/task/${task.recordId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#task-title', { timeout: 15_000 });
  const shown = await page.inputValue('#task-title');
  const comment = await page.inputValue('#comment-body');
  const title = shown === task.title ? "is the server's" : `is "${shown}"`;
  return {
    ok: shown === task.title && comment === '',
    observed: `title ${title}, comment box ${comment === '' ? 'empty' : 'holds text'}`,
  };
}

/**
 * Run in the page, so it is serialised whole and helpers stay inside it: what
 * its web storages, IndexedDB and Cache Storage hold.
 */
async function readTabStores() {
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const done = (request) =>
    new Promise((resolve, reject) => {
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
  const areas = [localStorage, sessionStorage].flatMap((area) =>
    Array.from({ length: area.length }, (_, index) => {
      const key = area.key(index);
      return `${key}=${area.getItem(key)}`;
    }),
  );
  const databases = await indexedDB.databases();
  const stored = await Promise.all(
    databases.map(async ({ name }) => {
      const db = await done(indexedDB.open(name));
      const stores = [...db.objectStoreNames].map((storeName) => {
        const store = db.transaction(storeName, 'readonly').objectStore(storeName);
        return Promise.all([done(store.getAllKeys()), done(store.getAll())]);
      });
      const read = await Promise.all(stores);
      db.close();
      return JSON.stringify(read);
    }),
  );
  const cached = await Promise.all(
    (await caches.keys()).map(async (cacheName) => {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();
      return await Promise.all(
        requests.map(
          async (request) => `${request.url} ${await (await cache.match(request)).text()}`,
        ),
      );
    }),
  );
  const entries = cached.flat();
  return {
    text: [...areas, document.cookie, ...stored, ...entries].join('\n'),
    databases: databases.length,
    caches: entries.length,
  };
}

/**
 * Everything the tab can hold, as one text: both web storages, every cookie
 * the context has, every IndexedDB database's every store, and every Cache
 * Storage entry's address and body.
 */
async function everyStore(page) {
  const inPage = await page.evaluate(readTabStores);
  const cookies = await page.context().cookies();
  return {
    text: `${inPage.text}\n${JSON.stringify(cookies)}`,
    summary:
      `local and session storage, ${String(cookies.length)} cookie(s), ` +
      `${String(inPage.databases)} IndexedDB database(s), ${String(inPage.caches)} cached response(s)`,
  };
}

// ------------------------------------------------------------------ standalone

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.launch();
  const database = connect(fromEnvFile('DATABASE_URL'), { source: 'browser-acceptance' });
  const admin = connectAsAdmin(fromEnvFile('DATABASE_ADMIN_URL'), { source: 'browser-acceptance' });
  try {
    const rows = await admin.execute('select id from public.businesses where key = $1', ['alpha']);
    await casesNoDraft({
      browser,
      database,
      admin,
      alpha: rows[0]?.id,
      stamp: new Date().toISOString(),
    });
  } catch (error) {
    record({
      case: 'ND run',
      action: 'the group itself',
      observed: `threw: ${String(error).slice(0, 400)}`,
      ok: false,
    });
  } finally {
    await browser.close();
    await closeQuietly(database);
    await closeQuietly(admin);
  }
  process.exitCode = standaloneStatus('C58 no draft', REQUIRED);
}
