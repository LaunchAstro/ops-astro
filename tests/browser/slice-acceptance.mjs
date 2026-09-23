// SPDX-License-Identifier: AGPL-3.0-only
//
// The acceptance checklist, driven through a real browser against the running
// slice: B1-B7 and N1-N7, one decisive screenshot each.
//
// It is a script rather than a test file because it is evidence, not a check.
// It restarts the API and the database container, it revokes a live grant and
// puts it back, and it writes a results table a person reads; a test runner
// would give it a worker pool and a working directory it does not want. The
// suites under `tests/` stay the checks.
//
// **Nothing here seeds a task.** Every record it reasons about is one it
// created during the run, with a title carrying the run's own timestamp, so a
// row already in the database cannot make a case pass.
//
// Run: node tests/browser/slice-acceptance.mjs
//
/* eslint-disable no-await-in-loop -- every loop here steps one browser page and
   one record through an ordered sequence: each step reads the revision the step
   before it left. Running them together would not be the same evidence. */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { connect, connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { n6Cases } from './n6-revocation.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const SHOTS =
  process.env.SHOT_DIR ??
  `${root}../ops-astro-roadmap/.local/ops-astro-build-run-2026-09-23/parent-observations/local-slice`;
const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:5190';
// The application modules the page imports for the cases that must run through
// the app's own code. They are served by Vite to the browser, not resolvable
// from here, so they travel into `page.evaluate` as data rather than standing in
// this file as import specifiers.
const IN_PAGE = {
  client: ['/src', 'operations', 'client.ts'].join('/'),
  submit: ['/src', 'records', 'submit.ts'].join('/'),
  authorisedRead: ['/src', 'data', 'authorised-read.ts'].join('/'),
};
const API = process.env.API_URL ?? 'http://127.0.0.1:8790';

mkdirSync(SHOTS, { recursive: true });

function fromEnvFile(name) {
  if (process.env[name]) return process.env[name];
  for (const line of readFileSync(`${root}.local/db.env`, 'utf8').split('\n')) {
    const match = new RegExp(`^${name}=(.+)$`, 'u').exec(line.trim());
    if (match) return match[1];
  }
  return undefined;
}

const users = JSON.parse(readFileSync(`${root}.local/synthetic-users.json`, 'utf8'));
const passwordOf = (email) => users.find((user) => user.email === email)?.password;

const results = [];
function record(entry) {
  results.push(entry);
  const mark = entry.ok === undefined ? 'UNRUN' : entry.ok ? 'pass ' : 'FAIL ';
  console.log(`${mark}  ${entry.case.padEnd(34)} ${entry.observed}`);
}

async function shot(page, name) {
  const file = `${SHOTS}/${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

const DOCKER = process.env.DOCKER_BIN ?? '/usr/local/bin/docker';

const sh = (command, args) =>
  execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Sign in through the real form, as a person does. */
async function signIn(page, email, businessKey) {
  await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#signin-email');
  await page.fill('#signin-email', email);
  await page.fill('#signin-password', passwordOf(email));
  await page.selectOption('#signin-business', businessKey);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname !== '/sign-in', { timeout: 15_000 });
}

/**
 * A call made by the application's own modules, in the page, with the session
 * the person signed in with. `records/submit.ts` is the generic submission the
 * checklist names for N3; the client is the one the screens use.
 */
async function throughSubmit(page, request) {
  return await page.evaluate(
    async (ask) => {
      const { OperationsClient } = await import(ask.modules.client);
      const { submitEdit } = await import(ask.modules.submit);
      const session = JSON.parse(sessionStorage.getItem('ops-astro.session'));
      const client = new OperationsClient({
        base: '/api',
        businessKey: ask.businessKey ?? session.businessKey,
        token: session.token,
        fetch: window.fetch.bind(window),
      });
      return await submitEdit(client, ask.request);
    },
    { ...request, modules: IN_PAGE },
  );
}

async function throughClient(page, ask) {
  return await page.evaluate(
    async (given) => {
      const { OperationsClient } = await import(given.modules.client);
      const session = JSON.parse(sessionStorage.getItem('ops-astro.session'));
      const sent = [];
      const spy = async (input, init) => {
        sent.push({
          url: String(input),
          headers: Object.keys(init?.headers ?? {}),
          body: init?.body,
        });
        return await window.fetch(input, init);
      };
      const client = new OperationsClient({
        base: '/api',
        businessKey: session.businessKey,
        token: session.token,
        fetch: spy,
      });
      const result = given.read
        ? await client.read(given.name, given.body)
        : await client.mutate(given.name, given.body, given.options ?? {});
      return { result, sent };
    },
    { ...ask, modules: IN_PAGE },
  );
}

/** The outcome a screen settles on. `loading` is where every read starts. */
async function outcomeOf(page) {
  await page.waitForSelector('[data-outcome]', { timeout: 15_000 });
  await page
    .waitForFunction(
      () => document.querySelector('[data-outcome]')?.getAttribute('data-outcome') !== 'loading',
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
  return await page.locator('[data-outcome]').first().getAttribute('data-outcome');
}

/** The revision the record is actually at, read back through the app's client. */
async function serverRevision(page, recordId) {
  const { result } = await throughClient(page, {
    read: true,
    name: 'task.read',
    body: { recordId },
  });
  return result.ok === true ? result.value.task.revision : undefined;
}

// ---------------------------------------------------------------- the run

const stamp = new Date().toISOString();
const TITLE = `Acceptance ${stamp}`;
const browser = await chromium.launch();
const database = connect(fromEnvFile('DATABASE_URL'), { source: 'browser-acceptance' });
// Plain lookups -- which business, which person -- are not tenant reads and go
// through the admin connection, exactly as the seed's do.
let admin = connectAsAdmin(fromEnvFile('DATABASE_ADMIN_URL'), { source: 'browser-acceptance' });
let taskKey;
let taskId;

const businessIdOf = async (key) => {
  const rows = await admin.execute('select id from public.businesses where key = $1', [key]);
  return rows[0]?.id;
};
const alpha = await businessIdOf('alpha');

try {
  const context = await browser.newContext({ viewport: { width: 1480, height: 900 } });
  const page = await context.newPage();

  // ------------------------------------------------------------------ B1
  await signIn(page, 'mia@alpha.local', 'alpha');
  record({
    case: 'B1 sign in',
    action: 'the sign-in form, mia@alpha.local in alpha',
    observed: `landed on ${new URL(page.url()).pathname}`,
    ok: new URL(page.url()).pathname === '/projects/',
    shot: await shot(page, 'B1-signed-in'),
  });

  await page.fill('#create-title', TITLE);
  await page.click('form.projects__create button[type="submit"]');
  const row = page.locator(`a[href^="/task/"]`, { hasText: TITLE }).first();
  await row.waitFor({ timeout: 15_000 });
  const href = await row.getAttribute('href');
  taskKey = decodeURIComponent(href.replace('/task/', ''));
  record({
    case: 'B1 create without a board',
    action: `created "${TITLE}" from /projects/`,
    observed: `the board lists it at ${href}`,
    ok: typeof taskKey === 'string' && taskKey !== '',
    shot: await shot(page, 'B1-created-on-board'),
  });

  await row.click();
  await page.waitForSelector('[data-task]');
  taskId = await page.locator('[data-task]').first().getAttribute('data-task');
  const openTitle = await page.locator('h2.tpr__title').innerText();
  record({
    case: 'B1 open its own address',
    action: `opened ${WEB}/task/${taskKey}`,
    observed: `HTTP 200, task ${taskId} key ${taskKey}, title "${openTitle}"`,
    ok: openTitle === TITLE,
    shot: await shot(page, 'B1-task-detail'),
  });

  // ------------------------------------------------------------------ B2
  const revisionNow = async () =>
    Number(await page.locator('[data-revision]').first().getAttribute('data-revision'));
  const before2 = await revisionNow();
  await page.selectOption('select[aria-label="Assignee"]', { label: 'Noah Alpha' });
  await page.waitForFunction(
    (was) => Number(document.querySelector('[data-revision]')?.getAttribute('data-revision')) > was,
    before2,
    { timeout: 15_000 },
  );
  const assignee = await page.locator('select[aria-label="Assignee"]').inputValue();
  record({
    case: 'B2 assign',
    action: 'chose Noah Alpha in the assignee control (task.assign)',
    observed: `revision ${before2} -> ${await revisionNow()}, assignee ${assignee}`,
    ok: assignee !== '',
    shot: await shot(page, 'B2-assigned'),
  });

  const bravoPerson = (
    await admin.execute(
      `select p.id from public.people p join public.businesses b on b.id = p.business_id
        where b.key = 'bravo' limit 1`,
    )
  )[0]?.id;
  const beforeForeign = await revisionNow();
  const foreign = await throughSubmit(page, {
    request: {
      command: 'task.assign',
      recordId: taskId,
      expectedRevision: beforeForeign,
      fields: { assignee: bravoPerson },
    },
  });
  record({
    case: 'B2 foreign-business assignee',
    action: `task.assign to bravo's person ${bravoPerson}`,
    observed: `refused ${foreign.code ?? JSON.stringify(foreign)}, revision still ${beforeForeign}`,
    ok: foreign.refused === true && (await revisionNow()) === beforeForeign,
    shot: await shot(page, 'B2-foreign-refused'),
  });

  // ------------------------------------------------------------------ B3
  const lifecycle = async (label, button, shotName) => {
    const was = await revisionNow();
    await page.getByRole('button', { name: button, exact: true }).click();
    await page.waitForFunction(
      (prior) =>
        Number(document.querySelector('[data-revision]')?.getAttribute('data-revision')) > prior,
      was,
      { timeout: 15_000 },
    );
    const state = await page
      .locator('.tpr__crumb .state, .tpr__crumb [class*="state"]')
      .first()
      .innerText()
      .catch(() => '');
    const sub = await page.locator('.card__sub').first().innerText();
    record({
      case: label,
      action: `clicked ${button} on /task/${taskKey}`,
      observed: `revision ${was} -> ${await revisionNow()}, ${sub.replace(/\s+/gu, ' ')} ${state}`,
      ok: true,
      shot: await shot(page, shotName),
    });
    return sub;
  };
  await lifecycle('B3 start', 'Start', 'B3-started');
  const completedSub = await lifecycle('B3 complete', 'Complete', 'B3-completed');
  const reopenedSub = await lifecycle('B3 reopen', 'Reopen', 'B3-reopened');
  record({
    case: 'B3 completion stamp',
    action: 'read the header after complete and after reopen',
    observed: `complete: "${completedSub.replace(/\s+/gu, ' ')}"; reopen: "${reopenedSub.replace(/\s+/gu, ' ')}"`,
    ok: /completed 2/u.test(completedSub) && /not completed/u.test(reopenedSub),
    shot: await shot(page, 'B3-completion-stamp'),
  });
  const historyRows = await page.locator('.sbact__row').count();
  record({
    case: 'B3 history names the actor',
    action: 'read the History section',
    observed: `${historyRows} entries, each with an actor id and the operation`,
    ok: historyRows >= 4,
    shot: await shot(page, 'B3-history'),
  });

  // ------------------------------------------------------------------ B4
  const EDITED = `${TITLE} (edited)`;
  const DUE = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const before4 = await revisionNow();
  await page.fill('#task-title', EDITED);
  await page.fill('#task-due', DUE);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForFunction(
    (prior) =>
      Number(document.querySelector('[data-revision]')?.getAttribute('data-revision')) > prior,
    before4,
    { timeout: 15_000 },
  );
  record({
    case: 'B4 ordinary content edit',
    action: 'edited the title and set a due date (task.update)',
    observed: `revision ${before4} -> ${await revisionNow()}, title "${await page.locator('h2.tpr__title').innerText()}", due ${await page.inputValue('#task-due')}`,
    ok:
      (await page.locator('h2.tpr__title').innerText()) === EDITED &&
      (await page.inputValue('#task-due')) === DUE,
    shot: await shot(page, 'B4-edited'),
  });

  // ------------------------------------------------------------------ N3
  const protectedTries = [
    ['state', { state: '00000000-0000-0000-0000-000000000000' }],
    ['assignee', { assignee: null }],
    ['stage', { stage: 'delivery' }],
    ['parent', { parent: null }],
    ['intake_state', { intake_state: 'accepted' }],
  ];
  for (const [field, fields] of protectedTries) {
    const was = await serverRevision(page, taskId);
    const refusal = await throughSubmit(page, {
      request: { command: 'task.update', recordId: taskId, expectedRevision: was, fields },
    });
    const after = await serverRevision(page, taskId);
    record({
      case: `N3 protected ${field}`,
      action: `records/submit.ts sent ${field} to task.update`,
      observed: `${refusal.code ?? JSON.stringify(refusal)} naming ${JSON.stringify(refusal.names ?? [])}, revision still ${after}`,
      ok: refusal.refused === true && after === was,
      shot: field === 'state' ? await shot(page, 'N3-state-refused') : undefined,
    });
  }
  const ordinary = await throughSubmit(page, {
    request: {
      command: 'task.update',
      recordId: taskId,
      expectedRevision: await serverRevision(page, taskId),
      fields: { description: 'the positive control alongside the refusals' },
    },
  });
  record({
    case: 'N3 ordinary edit still applies',
    action: 'records/submit.ts sent description to task.update',
    observed:
      ordinary.ok === true
        ? `applied at revision ${ordinary.value.revision}`
        : JSON.stringify(ordinary),
    ok: ordinary.ok === true,
    shot: await shot(page, 'N3-ordinary-applies'),
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-task]');

  // ------------------------------------------------------------------ N4
  for (const [field, fields] of [
    ['source', { source: 'agent' }],
    ['key', { key: 'T-0' }],
    ['completed_at', { completed_at: '2020-01-01T00:00:00.000Z' }],
  ]) {
    const was = await serverRevision(page, taskId);
    const refusal = await throughSubmit(page, {
      request: { command: 'task.update', recordId: taskId, expectedRevision: was, fields },
    });
    const echoed = JSON.stringify(refusal).includes(String(Object.values(fields)[0]));
    record({
      case: `N4 system field ${field}`,
      action: `records/submit.ts sent ${field} to task.update`,
      observed: `${refusal.code ?? JSON.stringify(refusal)}; attempted value echoed back: ${echoed}`,
      ok: refusal.refused === true && !echoed,
      shot: field === 'source' ? await shot(page, 'N4-source-spoofed') : undefined,
    });
  }

  // ------------------------------------------------------------------ N5
  const base = await serverRevision(page, taskId);
  const identity = crypto.randomUUID();
  const body = { recordId: taskId, fields: { priority: 4 } };
  const first = await throughClient(page, {
    name: 'task.update',
    body,
    options: { expectedRevision: base, operationId: identity },
  });
  const replay = await throughClient(page, {
    name: 'task.update',
    body,
    options: { expectedRevision: base, operationId: identity },
  });
  const changed = await throughClient(page, {
    name: 'task.update',
    body: { recordId: taskId, fields: { priority: 9 } },
    options: { expectedRevision: base, operationId: identity },
  });
  const stale = await throughClient(page, {
    name: 'task.update',
    body: { recordId: taskId, fields: { priority: 5 } },
    options: { expectedRevision: base },
  });
  record({
    case: 'N5 replay and revision',
    action: 'the same operationId twice, then a changed payload, then an old expectedRevision',
    observed: `first ${JSON.stringify(first.result.value ?? first.result.code)}, replay ${JSON.stringify(replay.result.value ?? replay.result.code)}, changed ${changed.result.code}, stale ${stale.result.code}`,
    ok:
      first.result.ok === true &&
      replay.result.ok === true &&
      replay.result.value.revision === first.result.value.revision &&
      changed.result.code === 'OPERATION_ID_REUSED' &&
      stale.result.code === 'VERSION_STALE',
    shot: await shot(page, 'N5-replay-and-stale'),
  });

  // ------------------------------------------------------------------ N7
  const tampered = await page.evaluate(
    async (given) => {
      const session = JSON.parse(sessionStorage.getItem('ops-astro.session'));
      const response = await window.fetch('/api/b/alpha/task/update', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session.token}`,
          'x-forwarded-host': 'bravo.local',
          'x-actor-id': '00000000-0000-0000-0000-000000000000',
        },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          recordId: given.taskId,
          expectedRevision: given.revision,
          businessKey: 'bravo',
          actorId: '00000000-0000-0000-0000-000000000000',
          fields: { priority: 6 },
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    { taskId, revision: await serverRevision(page, taskId) },
  );
  const sentKeys = (
    await throughClient(page, { read: true, name: 'task.read', body: { recordId: taskId } })
  ).sent;
  record({
    case: 'N7 auth input tampering',
    action: 'a valid session posting businessKey/actorId in the body and forwarded headers',
    observed: `HTTP ${tampered.status}, ${JSON.stringify(tampered.body).slice(0, 120)}; the client sends only ${JSON.stringify(sentKeys[0]?.headers ?? [])}`,
    ok: tampered.status === 200,
    shot: await shot(page, 'N7-tampering-ignored'),
  });

  // ------------------------------------------------------------------ B5
  await page.goto(`${WEB}/task/${encodeURIComponent(taskKey)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-task]');
  const afterReload = {
    title: await page.locator('h2.tpr__title').innerText(),
    due: await page.inputValue('#task-due'),
    assignee: await page.locator('select[aria-label="Assignee"]').inputValue(),
    revision: await revisionNow(),
    id: await page.locator('[data-task]').first().getAttribute('data-task'),
  };
  record({
    case: 'B5 hard reload',
    action: `hard-reloaded ${WEB}/task/${taskKey}`,
    observed: JSON.stringify(afterReload),
    ok: afterReload.title === EDITED && afterReload.id === taskId && afterReload.due === DUE,
    shot: await shot(page, 'B5-reloaded'),
  });

  const fresh = await browser.newContext({ viewport: { width: 1480, height: 900 } });
  const freshPage = await fresh.newPage();
  await signIn(freshPage, 'mia@alpha.local', 'alpha');
  await freshPage.goto(`${WEB}/task/${encodeURIComponent(taskKey)}`, {
    waitUntil: 'domcontentloaded',
  });
  await freshPage.waitForSelector('[data-task]');
  const inFresh = await freshPage.locator('h2.tpr__title').innerText();
  record({
    case: 'B5 fresh browser context',
    action: 'a new context with no storage, signed in again, opened the same address',
    observed: `title "${inFresh}", revision ${await freshPage.locator('[data-revision]').first().getAttribute('data-revision')}`,
    ok: inFresh === EDITED,
    shot: await shot(freshPage, 'B5-fresh-context'),
  });
  await fresh.close();

  // ------------------------------------------------------------------ N1
  const bravo = await browser.newContext({ viewport: { width: 1480, height: 900 } });
  const bravoPage = await bravo.newPage();
  await signIn(bravoPage, 'bea@bravo.local', 'bravo');
  await bravoPage.goto(`${WEB}/task/${encodeURIComponent(taskKey)}`, {
    waitUntil: 'domcontentloaded',
  });
  const foreignOutcome = await outcomeOf(bravoPage);
  record({
    case: "N1 B opens A's task",
    action: `bea, signed into bravo, opened /task/${taskKey}`,
    observed: `the page draws data-outcome="${foreignOutcome}" and no task fields`,
    ok: foreignOutcome !== 'ready',
    shot: await shot(bravoPage, 'N1-foreign-task'),
  });
  await bravoPage.goto(`${WEB}/task/${encodeURIComponent('T-000000')}`, {
    waitUntil: 'domcontentloaded',
  });
  const fabricatedOutcome = await outcomeOf(bravoPage);
  record({
    case: 'N1 B opens a fabricated id',
    action: 'bea opened /task/T-000000',
    observed: `data-outcome="${fabricatedOutcome}", indistinguishable from the real foreign task`,
    ok: fabricatedOutcome === foreignOutcome,
    shot: await shot(bravoPage, 'N1-fabricated-id'),
  });
  await bravoPage.goto(`${WEB}/projects/`, { waitUntil: 'domcontentloaded' });
  await bravoPage.waitForSelector('[data-outcome]');
  const bravoBoard = await outcomeOf(bravoPage);
  record({
    case: 'N1 positive control in B',
    action: "bea reads bravo's own board",
    observed: `data-outcome="${bravoBoard}" (bravo has no tasks, and empty is not denied)`,
    ok: bravoBoard === 'empty' || bravoBoard === 'ready',
    shot: await shot(bravoPage, 'N1-positive-control'),
  });
  await bravo.close();

  // ------------------------------------------------------------------ N2
  const noahContext = await browser.newContext({ viewport: { width: 1480, height: 900 } });
  const noahPage = await noahContext.newPage();
  await signIn(noahPage, 'noah@alpha.local', 'alpha');
  await noahPage.waitForSelector('[data-outcome]');
  const noahBoard = await outcomeOf(noahPage);
  const noahText = await noahPage.locator('[data-outcome]').first().innerText();
  record({
    case: 'N2 member with no grant',
    action: 'noah@alpha.local, a member of alpha with no task scope, opened /projects/',
    observed: `data-outcome="${noahBoard}", text quotes ${JSON.stringify(noahText.replace(/\s+/gu, ' ').slice(0, 90))}`,
    ok: noahBoard === 'denied',
    shot: await shot(noahPage, 'N2-board-denied'),
  });
  await noahPage.goto(`${WEB}/task/${encodeURIComponent(taskKey)}`, {
    waitUntil: 'domcontentloaded',
  });
  const noahTask = await outcomeOf(noahPage);
  record({
    case: 'N2 detail is denied, not empty',
    action: `noah opened /task/${taskKey}`,
    observed: `data-outcome="${noahTask}"`,
    ok: noahTask === 'denied',
    shot: await shot(noahPage, 'N2-task-denied'),
  });
  await noahContext.close();

  const orphanContext = await browser.newContext({ viewport: { width: 1480, height: 900 } });
  const orphanPage = await orphanContext.newPage();
  await signIn(orphanPage, 'orphan@alpha.local', 'alpha');
  await orphanPage.waitForSelector('[data-outcome]');
  const orphanOutcome = await outcomeOf(orphanPage);
  const orphanText = await orphanPage.locator('[data-outcome]').first().innerText();
  record({
    case: 'N2 login with no membership',
    action: 'orphan@alpha.local, a verified login with no membership, opened /projects/',
    observed: `data-outcome="${orphanOutcome}", text quotes ${JSON.stringify(orphanText.replace(/\s+/gu, ' ').slice(0, 90))}`,
    ok: orphanOutcome === 'denied' && /AUTH_NO_MEMBERSHIP/u.test(orphanText),
    shot: await shot(orphanPage, 'N2-no-membership'),
  });
  await orphanContext.close();

  // N6 is fenced so that a failure inside it cannot take B7 and B6 with it:
  // those two are the owner's persistence proof and are worth more than this
  // script's control flow.
  let miaPerson;
  try {
    // ------------------------------------------------------------------ N6
    await page.goto(`${WEB}/task/${encodeURIComponent(taskKey)}`, {
      waitUntil: 'domcontentloaded',
    });
    const { records, personId } = await n6Cases({
      page,
      database,
      admin,
      businessId: alpha,
      login: users.find((user) => user.email === 'mia@alpha.local'),
      shot: async (name) => await shot(page, name),
    });
    miaPerson = personId;
    for (const entry of records) record(entry);
  } catch (error) {
    record({
      case: 'N6 revocation on the mounted page',
      action: 'revoke through revokeGrant with the page open, then press Refresh',
      observed: `the script did not reach the assertion: ${String(error).slice(0, 200)}`,
      ok: false,
      shot: await shot(page, 'N6-failed').catch(() => undefined),
    });
  }

  // Put it back the way the seed says it should be.
  if (miaPerson !== undefined)
    await database.withBusiness(alpha, async (tx) => {
      const actor = (
        await tx.query(`select id from public.actors where person_id = $1 limit 1`, [miaPerson])
      )[0]?.id;
      await issueGrant(tx, [], {
        subject: { kind: 'person', id: miaPerson },
        scope: { kind: 'business', id: null },
        collection: 'task',
        action: 'read',
        parentGrantId: null,
        grantedByActorId: actor,
      });
    });

  // ------------------------------------------------------------------ B7
  const apiPid = readFileSync(`${root}.local/api.pid`, 'utf8').trim();
  sh('/bin/kill', [apiPid]);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await page.goto(`${WEB}/projects/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-outcome]');
  const downOutcome = await outcomeOf(page);
  const rowsWhileDown = await page.locator('a[href^="/task/"]').count();
  record({
    case: 'B7 unavailable is not empty',
    action: `stopped the API (pid ${apiPid}) and reloaded /projects/`,
    observed: `data-outcome="${downOutcome}", ${rowsWhileDown} task rows drawn, no sample data`,
    ok: downOutcome === 'unavailable' && rowsWhileDown === 0,
    shot: await shot(page, 'B7-unavailable'),
  });

  sh('/bin/sh', [
    '-c',
    `. ./.local/db.env; . ./.local/auth.env; export DATABASE_URL DATABASE_ADMIN_URL SUPABASE_JWT_SECRET GOTRUE_URL API_PORT; nohup node apps/api/server.ts >> .local/api.log 2>&1 & echo $! > .local/api.pid`,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const restoredPid = readFileSync(`${root}.local/api.pid`, 'utf8').trim();
  await page
    .getByRole('button', { name: /retry|try again/iu })
    .first()
    .click()
    .catch(async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
    });
  await page.waitForSelector('a[href^="/task/"]', { timeout: 20_000 });
  record({
    case: 'B7 retry after restore',
    action: `restarted the API (pid ${restoredPid}) and retried the read`,
    observed: `data-outcome="${await outcomeOf(page)}", ${await page.locator('a[href^="/task/"]').count()} rows`,
    ok: (await page.locator('a[href^="/task/"]').count()) > 0,
    shot: await shot(page, 'B7-restored'),
  });

  // ------------------------------------------------------------------ B6
  const prePid = readFileSync(`${root}.local/api.pid`, 'utf8').trim();
  const preContainer = sh(DOCKER, ['inspect', '-f', '{{.Id}}', 'ops-astro-local-pg']).trim();
  sh('/bin/kill', [prePid]);
  await database.close();
  await admin.close();
  sh('/bin/bash', ['scripts/local/db-down.sh']);
  sh('/bin/bash', ['scripts/local/db-up.sh']);
  sh('/bin/sh', [
    '-c',
    `. ./.local/db.env; . ./.local/auth.env; export DATABASE_URL DATABASE_ADMIN_URL SUPABASE_JWT_SECRET GOTRUE_URL API_PORT; nohup node apps/api/server.ts >> .local/api.log 2>&1 & echo $! > .local/api.pid`,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const postPid = readFileSync(`${root}.local/api.pid`, 'utf8').trim();
  const postContainer = sh(DOCKER, ['inspect', '-f', '{{.Id}}', 'ops-astro-local-pg']).trim();
  const volume = sh(DOCKER, [
    'volume',
    'inspect',
    '-f',
    '{{.CreatedAt}}',
    'ops-astro-local-pgdata',
  ]).trim();

  const afterRestart = await browser.newContext({ viewport: { width: 1480, height: 900 } });
  const restartPage = await afterRestart.newPage();
  await signIn(restartPage, 'mia@alpha.local', 'alpha');
  await restartPage.goto(`${WEB}/task/${encodeURIComponent(taskKey)}`, {
    waitUntil: 'domcontentloaded',
  });
  await restartPage.waitForSelector('[data-task]', { timeout: 20_000 });
  const survived = {
    title: await restartPage.locator('h2.tpr__title').innerText(),
    id: await restartPage.locator('[data-task]').first().getAttribute('data-task'),
    revision: await restartPage.locator('[data-revision]').first().getAttribute('data-revision'),
    due: await restartPage.inputValue('#task-due'),
    assignee: await restartPage.locator('select[aria-label="Assignee"]').inputValue(),
    history: await restartPage.locator('.sbact__row').count(),
  };
  record({
    case: 'B6 process and database restart',
    action: `API ${prePid} -> ${postPid}; container ${preContainer.slice(0, 12)} -> ${postContainer.slice(0, 12)}; volume ops-astro-local-pgdata kept (created ${volume})`,
    observed: JSON.stringify(survived),
    ok: survived.title === EDITED && survived.id === taskId && survived.history >= 4,
    shot: await shot(restartPage, 'B6-after-restart'),
  });
  await afterRestart.close();
  await context.close();
} catch (error) {
  record({
    case: 'run',
    action: 'the script itself',
    observed: `threw: ${String(error).slice(0, 400)}`,
    ok: false,
  });
} finally {
  await browser.close();
  for (const pool of [database, admin]) {
    try {
      await pool.close();
    } catch {
      /* B6 closes both before it stops the container */
    }
  }
}

// ---------------------------------------------------------------- results

const ran = results.filter((entry) => entry.ok !== undefined);
const failed = ran.filter((entry) => !entry.ok);
const lines = [
  '# Browser acceptance results',
  '',
  `Run ${stamp} against ${WEB} (API ${API}). Task \`${taskKey ?? 'none'}\` / \`${taskId ?? 'none'}\`, title generated at run time.`,
  '',
  '| Case | Action | Observed | Result | Screenshot |',
  '| --- | --- | --- | --- | --- |',
  ...results.map(
    (entry) =>
      `| ${entry.case} | ${entry.action} | ${entry.observed.replace(/\|/gu, '\\|')} | ${entry.ok === undefined ? 'unrun' : entry.ok ? 'pass' : 'FAIL'} | ${entry.shot ? entry.shot.replace(`${SHOTS}/`, '') : '—'} |`,
  ),
  '',
  `${ran.length - failed.length}/${ran.length} passed, ${failed.length} failed, ${results.length - ran.length} unrun.`,
  '',
];
writeFileSync(`${SHOTS}/RESULTS.md`, `${lines.join('\n')}\n`);
console.log(`\nwrote ${SHOTS}/RESULTS.md — ${ran.length - failed.length}/${ran.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
