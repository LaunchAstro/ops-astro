// SPDX-License-Identifier: AGPL-3.0-only
//
// N6-N7: authority the request cannot talk its way past.
//
// N7 is input tampering, and since the D06 correction it has two different
// answers depending on where the caller puts the claim.
//
// A body carrying one of the server's own fields -- `actorId`, `business_id`,
// `person_id` and the rest of `SYSTEM_OWNED_FIELDS` in
// `packages/core-records/src/commands/prepare.ts` -- is refused `422
// FIELD_NOT_WRITABLE`, the refusal names the offending keys, and nothing is
// written. The boundary used to drop those fields and apply the write anyway,
// so the caller got a `200` and no correction: a client that believed it had
// set the actor went on believing it, and the mistake lived there while the
// server looked fine. A refusal naming the keys is the only answer that gets
// them removed, so this case proves both halves -- the typed refusal, and the
// record still at the revision and the values it held before the attempt. A
// write that went through after a quiet drop is a failure here.
//
// Forged headers are the other answer. `Host`, `X-Forwarded-Host`,
// `X-Forwarded-For`, `x-actor-id` and `x-business-key` are not where the server
// reads the caller from, so a request carrying them is ordinary and is
// accepted -- but HTTP 200 is not the evidence. The evidence is who the write
// was recorded against, so the case rereads the task through the application's
// own client and checks the newest history entry against the session's actor
// rather than the one the headers named. The third row is the control: the same
// session and the same ordinary payload with nothing forged, so neither refusal
// above can be a boundary that has started saying no to everything.
//
// N6 is revocation while the page is open, and it runs in `n6-revocation.mjs`,
// which is a module of its own because it is also runnable alone. It is fenced
// here so that a failure inside it cannot take B7 and B6 with it: those two are
// the owner's persistence proof and are worth more than this script's control
// flow. The grant it revokes is put back through the authority path afterwards.
//
// Run: node tests/browser/cases-n6-n7.mjs  (N7 alone: N6 needs the pools the
// entry point owns)

import { chromium } from 'playwright';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  API,
  VIEWPORT,
  WEB,
  record,
  serverTask,
  shot,
  signIn,
  standaloneStatus,
  throughClient,
  users,
} from './harness.mjs';
import { n6Cases } from './n6-revocation.mjs';

/** The actor and business nobody is: whatever the caller claims, this is not it. */
const FORGED_ACTOR = '00000000-0000-0000-0000-000000000000';
const FORGED_BUSINESS = 'bravo';

/**
 * The system-owned keys this case plants in the body, and expects back by name.
 * All three are in `SYSTEM_OWNED_FIELDS`, so all three are reported in the
 * refusal's `names`, sorted. `businessKey` is planted beside them and is
 * deliberately not asserted on: the business is a path segment rather than a
 * request field, so the server owns it without the field existing at all, and a
 * refusal names keys a reader can look up. Its `fixes` say where the business
 * does come from.
 */
const PLANTED = ['actorId', 'business_id', 'person_id'];

/** Headers a tampering caller adds, none of which the server may read an identity from. */
const FORGED_HEADERS = {
  host: `${FORGED_BUSINESS}.local`,
  'x-forwarded-host': `${FORGED_BUSINESS}.local`,
  'x-forwarded-for': '203.0.113.7',
  'x-actor-id': FORGED_ACTOR,
  'x-business-key': FORGED_BUSINESS,
};

/** A write that landed: both reads answered, and the revision moved on. */
const advanced = (before, after) =>
  before !== undefined && after !== undefined && after.revision > before.revision;

export async function caseN7(run) {
  const { page, state } = run;
  await bodyClaimRefused(page, state.taskId);
  await forgedHeadersKeepTheSessionActor(page, state.taskId);
  await theSameRequestUntampered(page, state.taskId);
}

/**
 * The tampered request, made with the page's own `fetch` and not through the
 * application's client, which has no way to put these fields in a body at all.
 */
async function postClaimingSystemOwnedFields(page, taskId, revision) {
  return await page.evaluate(
    async (given) => {
      const session = JSON.parse(sessionStorage.getItem('ops-astro.session'));
      const response = await window.fetch('/api/b/alpha/task/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          recordId: given.taskId,
          expectedRevision: given.revision,
          ...Object.fromEntries(given.planted.map((field) => [field, given.actor])),
          businessKey: given.business,
          fields: { priority: 6 },
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    { taskId, revision, planted: PLANTED, actor: FORGED_ACTOR, business: FORGED_BUSINESS },
  );
}

/** The refusal, and the record left exactly as it was. */
async function bodyClaimRefused(page, taskId) {
  const before = await serverTask(page, taskId);
  const refusal = await postClaimingSystemOwnedFields(page, taskId, before?.revision);
  const named = refusal.body?.names ?? [];
  const fixes = refusal.body?.fixes ?? [];
  // Reread through the app's own client: "nothing was written" is a fact about
  // what the server hands back, not about the response body of the refusal.
  const after = await serverTask(page, taskId);
  record({
    case: 'N7 a body claiming a server-owned field is refused',
    action: `a valid session posting ${PLANTED.join(', ')} and businessKey beside fields.priority`,
    observed:
      `HTTP ${String(refusal.status)} ${String(refusal.body?.code)}, names ${JSON.stringify(named)}, ` +
      `${String(fixes.length)} fix(es); the record is still revision ${String(after?.revision)} ` +
      `(was ${String(before?.revision)}) at priority ${JSON.stringify(after?.priority)} (was ${JSON.stringify(before?.priority)})`,
    ok:
      refusal.status === 422 &&
      refusal.body?.code === 'FIELD_NOT_WRITABLE' &&
      PLANTED.every((field) => named.includes(field)) &&
      fixes.length > 0 &&
      before !== undefined &&
      after !== undefined &&
      after.revision === before.revision &&
      after.priority === before.priority,
    shot: await shot(page, 'N7-tampering-refused'),
  });
}

/**
 * The write the headers cannot rename.
 *
 * It goes straight at the API rather than through the dev server, because Vite
 * answers an unfamiliar `Host` with a 403 of its own before the API sees the
 * request, and a forgery the proxy eats proves nothing. The session is still
 * the page's: its bearer token is read out and presented unchanged. The actor
 * that session really is comes from the history the app already shows -- the
 * newest applied entry before this attempt -- because nothing else the browser
 * can reach carries an actor id, and a literal here would compare the record
 * against this file.
 */
async function forgedHeadersKeepTheSessionActor(page, taskId) {
  const before = await serverTask(page, taskId);
  const sessionActor = before?.history.at(-1)?.actorId;
  const token = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem('ops-astro.session')).token,
  );
  const tampered = await page.request.post(`${API}/api/b/alpha/task/update`, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...FORGED_HEADERS,
    },
    data: {
      operationId: crypto.randomUUID(),
      recordId: taskId,
      expectedRevision: before?.revision,
      fields: { priority: 7 },
    },
  });
  const after = await serverTask(page, taskId);
  const wrote = after?.history.at(-1);
  record({
    case: 'N7 forged headers cannot change who wrote',
    action:
      'the same session posting a clean payload with forged Host, X-Forwarded-*, x-actor-id and x-business-key',
    observed:
      `HTTP ${String(tampered.status())}, revision ${String(before?.revision)} -> ${String(after?.revision)}; ` +
      `newest history entry ${String(wrote?.operation)} by ${String(wrote?.actorId)}, which is ` +
      `${wrote?.actorId === sessionActor ? 'the session actor' : `not the session actor ${String(sessionActor)}`} and ` +
      `${wrote?.actorId === FORGED_ACTOR ? 'the forged one' : 'not the forged one'}`,
    ok:
      tampered.status() === 200 &&
      advanced(before, after) &&
      typeof sessionActor === 'string' &&
      sessionActor !== FORGED_ACTOR &&
      wrote?.actorId === sessionActor,
  });
}

/** The control: nothing forged, so nothing to refuse. */
async function theSameRequestUntampered(page, taskId) {
  const before = await serverTask(page, taskId);
  const { result } = await throughClient(page, {
    name: 'task.update',
    body: { recordId: taskId, fields: { priority: 5 } },
    options: { expectedRevision: before?.revision, operationId: crypto.randomUUID() },
  });
  const after = await serverTask(page, taskId);
  record({
    case: 'N7 the permitted request is still accepted',
    action: 'the same session sending the same ordinary payload through the app client',
    observed:
      `${result.ok === true ? 'applied' : `refused ${String(result.code)}`}, revision ` +
      `${String(before?.revision)} -> ${String(after?.revision)}, priority ${JSON.stringify(after?.priority)}`,
    ok: result.ok === true && advanced(before, after),
  });
}

export async function casesN6(run) {
  const { page, database, admin, alpha, state } = run;
  let miaPerson;
  try {
    await page.goto(`${WEB}/task/${encodeURIComponent(state.taskKey)}`, {
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
  if (miaPerson !== undefined) await restoreTaskRead(database, alpha, miaPerson);
}

/** Put the revoked grant back the way the seed says it should be. */
export async function restoreTaskRead(database, businessId, personId) {
  await database.withBusiness(businessId, async (tx) => {
    const actor = (
      await tx.query(`select id from public.actors where person_id = $1 limit 1`, [personId])
    )[0]?.id;
    await issueGrant(tx, [], {
      subject: { kind: 'person', id: personId },
      scope: { kind: 'business', id: null },
      collection: 'task',
      action: 'read',
      parentGrantId: null,
      grantedByActorId: actor,
    });
  });
}

// ------------------------------------------------------------------ standalone

/** The task this group makes for itself, so it never writes on anyone else's. */
async function createTask(page, title) {
  await page.goto(`${WEB}/projects/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#create-title', { timeout: 15_000 });
  await page.fill('#create-title', title);
  await page.click('form.projects__create button[type="submit"]');
  const row = page.locator('a[href^="/task/"]', { hasText: title }).first();
  await row.waitFor({ timeout: 15_000 });
  const href = await row.getAttribute('href');
  await row.click();
  await page.waitForSelector('[data-task]', { timeout: 15_000 });
  // The key in the address is the human-facing one; `data-task` on the detail
  // carries the record identifier `task.update` and `task.read` actually name.
  return {
    key: decodeURIComponent(href.replace('/task/', '')),
    id: await page.locator('[data-task]').first().getAttribute('data-task'),
  };
}

// N7 only: `casesN6` revokes a live grant through the database and admin pools
// the entry point opens, which a standalone run of this file does not have.
if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const run = { browser, page, stamp: new Date().toISOString(), state: {} };
  let made;
  try {
    await signIn(page, 'ada@alpha.local', 'alpha');
    made = await createTask(page, `Tampering ${run.stamp}`);
    run.state.taskKey = made.key;
    run.state.taskId = made.id;
    await caseN7(run);
  } catch (error) {
    record({
      case: 'N7 run',
      action: 'the group itself',
      observed: `threw: ${String(error).slice(0, 400)}`,
      ok: false,
    });
  } finally {
    await browser.close();
  }
  console.log(`task created by this run: ${String(made?.key)} / ${String(made?.id)}`);
  process.exitCode = standaloneStatus('n7', ['N7']);
}
