// SPDX-License-Identifier: AGPL-3.0-only
//
// B7 and B6: the slice is not a picture of a slice.
//
// B7 stops the API under a mounted page: the board must say `unavailable` and
// draw nothing, because a board that fell back to sample rows while the server
// was down would be indistinguishable from one that was working. B6 then stops
// the API *and* the database container, brings both back with the volume kept,
// and opens the task again in a browser that has never seen it.
//
// These two run last and they are why the N6 block above them is fenced.
//
// **What B6 restarts is configuration** (`restartTargetOf` in `harness.mjs`):
// `B6_PG_CONTAINER` and `B6_PG_VOLUME` name the Postgres pair, defaulting to
// the live `ops-astro-local-pg` and `ops-astro-local-pgdata`, and the API it
// starts again listens on `API_URL`'s port. The target is resolved when this
// module loads, so a refused name stops the run before any case has touched
// anything.
//
// **B6 also carries the runtime records across the restart.** Before it stops
// anything it makes two tasks of its own: one with a live proposal whose gate
// is pending, and one approved and picked up by the business's agent, so that
// its reservation has a lease and an attempt. The approval is how P2 makes one
// (`task:decide` issued and taken back around the click); the lease is the
// pickup's, because an approval writes the attempt and only `task.pickup` binds
// a lease (`core-runtime/src/pickup.ts`). After the restart a browser that has
// never seen either task opens both and the same ids and states have to come
// back, from the screen and from `task.read` alike.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { issueGrant, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  API,
  DOCKER,
  VIEWPORT,
  WEB,
  outcomeOf,
  record,
  restartTargetOf,
  revisionOn,
  root,
  serverTask,
  sh,
  shot,
  signIn,
  throughClient,
  users,
} from './harness.mjs';

const TARGET = restartTargetOf(process.env);

/** Start the API detached, exactly as `scripts/local/api-up.sh` does, on `API_URL`'s port. */
const API_UP = `. ./.local/db.env; . ./.local/auth.env; API_PORT=${TARGET.apiPort}; export DATABASE_URL DATABASE_ADMIN_URL SUPABASE_JWT_SECRET GOTRUE_URL API_PORT; nohup node apps/api/server.ts >> .local/api.log 2>&1 & echo $! > .local/api.pid`;

/** The volume mounted where Postgres 18 keeps its cluster, as `db-up.sh` mounts it. */
const mountedVolume = () =>
  sh(DOCKER, [
    'inspect',
    '-f',
    '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Name}}{{end}}{{end}}',
    TARGET.container,
  ]).trim();

const apiPid = () => readFileSync(`${root}.local/api.pid`, 'utf8').trim();
const settle = async (ms) => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

export async function casesB6toB7(run) {
  await casesB7(run);
  await caseB6(run);
}

async function casesB7(run) {
  const { page } = run;
  const stopped = apiPid();
  sh('/bin/kill', [stopped]);
  await settle(1500);
  await page.goto(`${WEB}/projects/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-outcome]');
  const downOutcome = await outcomeOf(page);
  const rowsWhileDown = await page.locator('a[href^="/task/"]').count();
  record({
    case: 'B7 unavailable is not empty',
    action: `stopped the API (pid ${stopped}) and reloaded /projects/`,
    observed: `data-outcome="${downOutcome}", ${rowsWhileDown} task rows drawn, no sample data`,
    ok: downOutcome === 'unavailable' && rowsWhileDown === 0,
    shot: await shot(page, 'B7-unavailable'),
  });

  sh('/bin/sh', ['-c', API_UP]);
  await settle(3000);
  const restoredPid = apiPid();
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
}

/** Try `check` once a second until it holds or the tries run out. */
async function until(check, tries) {
  if (await check()) return true;
  if (tries <= 1) return false;
  await settle(1000);
  return await until(check, tries - 1);
}

const answers = (probe) => {
  try {
    probe();
    return true;
  } catch {
    return false;
  }
};

/**
 * Stop the database container and start it again, keeping its volume. The
 * live pair goes through the two scripts exactly as the registered run always
 * has; a lane's own container is stopped and started directly, because those
 * scripts name the live container and nothing else.
 */
async function restartDatabase() {
  if (TARGET.live) {
    sh('/bin/bash', ['scripts/local/db-down.sh']);
    sh('/bin/bash', ['scripts/local/db-up.sh']);
    return true;
  }
  sh(DOCKER, ['stop', TARGET.container]);
  sh(DOCKER, ['start', TARGET.container]);
  return await until(
    () =>
      answers(() => sh(DOCKER, ['exec', TARGET.container, 'pg_isready', '-q', '-U', 'postgres'])),
    60,
  );
}

async function apiHealthy() {
  try {
    const response = await fetch(`${API}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function caseB6(run) {
  const { browser, database, admin, state } = run;
  const before = await runtimeRecordsBefore(run);
  const prePid = apiPid();
  const preContainer = sh(DOCKER, ['inspect', '-f', '{{.Id}}', TARGET.container]).trim();
  const preVolume = mountedVolume();
  sh('/bin/kill', [prePid]);
  await database.close();
  await admin.close();
  const databaseBack = await restartDatabase();
  sh('/bin/sh', ['-c', API_UP]);
  await settle(6000);
  const apiBack = await until(apiHealthy, 20);
  const postPid = apiPid();
  const postContainer = sh(DOCKER, ['inspect', '-f', '{{.Id}}', TARGET.container]).trim();
  const postVolume = mountedVolume();
  const volume = sh(DOCKER, ['volume', 'inspect', '-f', '{{.CreatedAt}}', TARGET.volume]).trim();

  const afterRestart = await browser.newContext({ viewport: VIEWPORT });
  const restartPage = await afterRestart.newPage();
  await signIn(restartPage, 'mia@alpha.local', 'alpha');
  await restartPage.goto(`${WEB}/task/${encodeURIComponent(state.taskKey)}`, {
    waitUntil: 'domcontentloaded',
  });
  await restartPage.waitForSelector('[data-task]', { timeout: 20_000 });
  const survived = {
    title: await restartPage.locator('h2.tpr__title').innerText(),
    id: await restartPage.locator('[data-task]').first().getAttribute('data-task'),
    revision: String(await revisionOn(restartPage)),
    due: await restartPage.inputValue('#task-due'),
    assignee: await restartPage.locator('select[aria-label="Assignee"]').inputValue(),
    history: await restartPage.locator('.sbact__row').count(),
  };
  record({
    case: 'B6 process and database restart',
    action: `API ${prePid} -> ${postPid} on port ${TARGET.apiPort}; container ${TARGET.container} ${preContainer.slice(0, 12)} -> ${postContainer.slice(0, 12)}; volume ${TARGET.volume} mounted before (${preVolume}) and after (${postVolume}), created ${volume}`,
    observed: JSON.stringify(survived),
    ok:
      databaseBack &&
      apiBack &&
      postPid !== prePid &&
      preVolume === TARGET.volume &&
      postVolume === TARGET.volume &&
      survived.title === state.edited &&
      survived.id === state.taskId &&
      survived.history >= 4,
    shot: await shot(restartPage, 'B6-after-restart'),
  });
  await afterRestart.close();
  await runtimeRecordsAfter(run, before);
}

// ---------------------------------------------------------------------------
// B6 runtime records: a pending gate, a lease and an attempt across the restart.

/** The slug shape `proposal_versions` and `delegations` both check against, as P1 uses. */
const PURPOSE = 'client_renewal_quote';
const APPROVE = '[data-decide="approve"]';

/** `.local/auth.env` is where the local identity service is named. The environment wins. */
function gotrueUrl() {
  if (process.env.GOTRUE_URL) return process.env.GOTRUE_URL;
  const line = readFileSync(`${root}.local/auth.env`, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('GOTRUE_URL='));
  return line === undefined ? 'http://127.0.0.1:54391' : line.slice('GOTRUE_URL='.length).trim();
}

/** The person behind a seeded login, by the subject GoTrue minted, as the P group finds ada. */
async function personOf(admin, businessId, email) {
  const subject = users.find((user) => user.email === email)?.subject;
  const rows = await admin.execute(
    `select pl.person_id, a.id as actor_id
       from public.logins l
       join public.person_logins pl on pl.login_id = l.id and pl.business_id = l.business_id
       join public.actors a on a.person_id = pl.person_id
      where l.business_id = $1 and l.provider = 'supabase' and l.subject = $2 and pl.active
      limit 1`,
    [businessId, subject],
  );
  if (rows[0] === undefined) throw new Error(`no person for ${email} (subject ${String(subject)})`);
  return rows[0];
}

/** `task:decide` for as long as the approval needs it, then taken back, as P2 holds it. */
async function withDecideGrant(database, businessId, person, work) {
  const id = await database.withBusiness(businessId, async (tx) => {
    const issued = await issueGrant(tx, [], {
      subject: { kind: 'person', id: person.person_id },
      scope: { kind: 'business', id: null },
      collection: 'task',
      action: 'decide',
      parentGrantId: null,
      grantedByActorId: person.actor_id,
    });
    if (!issued.ok) throw new Error(`decide grant refused ${issued.refusal.code}`);
    return issued.value;
  });
  try {
    return await work();
  } finally {
    await database.withBusiness(businessId, async (tx) => revokeGrant(tx, id));
  }
}

/** A task of B6's own, made through the board's form, left open on its page. */
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
  const recordId = await page.locator('[data-task]').first().getAttribute('data-task');
  return { href, recordId };
}

async function openTask(page, href) {
  await page.goto(`${WEB}${href}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-task]', { timeout: 20_000 });
  await outcomeOf(page);
}

/** A proposal through the client the screens use, opening a new lineage. */
async function propose(page, task) {
  const { result } = await throughClient(page, {
    name: 'task.propose',
    body: {
      recordId: task.recordId,
      purpose: PURPOSE,
      maximumMinor: 25_000,
      currency: 'AUD',
      payload: { step: PURPOSE },
      step: { kind: PURPOSE, payload: { step: PURPOSE } },
    },
    options: { expectedRevision: await revisionOn(page) },
  });
  if (result.ok !== true)
    throw new Error(`task.propose answered ${JSON.stringify(result).slice(0, 300)}`);
  await openTask(page, task.href);
}

/**
 * The alpha agent picks the reservation up on the agent prefix, which is what
 * binds a lease. What it answers is kept, because the same agent hands the work
 * back after the restart: a delegation left live would refuse the next run's
 * pickup `DELEGATION_ALREADY_LIVE`, on this business, for as long as it lived.
 */
async function pickUp(reservationId) {
  const agent = JSON.parse(readFileSync(`${root}.local/synthetic-agents.json`, 'utf8')).find(
    (entry) => entry.business === 'alpha',
  );
  const token = await fetch(`${gotrueUrl()}/token?grant_type=password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: agent.email, password: agent.password }),
  }).then(async (response) => (await response.json()).access_token);
  const response = await fetch(`${API}/api/a/b/alpha/task/pickup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${String(token)}` },
    body: JSON.stringify({ operationId: `b6-${randomUUID()}`, reservationId }),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status !== 200) {
    throw new Error(
      `task.pickup answered ${String(response.status)} ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  const detail = body.detail ?? body;
  return { token, credential: detail.credential, leaseId: detail.leaseId, fence: detail.fence };
}

/** The same agent hands the work back to the restarted API, settling its delegation. */
async function handBack(picked) {
  try {
    const response = await fetch(`${API}/api/a/b/alpha/task/handback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${String(picked.token)}`,
        'x-agent-delegation': String(picked.credential),
      },
      body: JSON.stringify({
        operationId: `b6-${randomUUID()}`,
        leaseId: picked.leaseId,
        fence: picked.fence,
        outcome: 'completed',
        report: { note: 'B6 carried this lease across a restart' },
      }),
    });
    return { status: response.status, text: (await response.text()).slice(0, 200) };
  } catch (error) {
    return { status: 0, text: String(error).slice(0, 200) };
  }
}

/** What the screen draws of the task's runtime records. No id here is this file's. */
async function drawnRuntime(page) {
  return await page.evaluate(() => {
    const lineage = document.querySelector('[data-lineage-id]');
    const version = lineage?.querySelector('[data-version-id]') ?? null;
    const gate = version?.querySelector('[data-gate-state]') ?? null;
    const reservation = document.querySelector('[data-reservation-id]');
    const lease = reservation?.querySelector('[data-lease-state]') ?? null;
    const attempt = reservation?.querySelector('[data-attempt-state]') ?? null;
    return {
      lineageId: lineage?.dataset.lineageId ?? null,
      lineageState: lineage?.dataset.lineageState ?? null,
      versionId: version?.dataset.versionId ?? null,
      gateState: gate?.dataset.gateState ?? null,
      gateExpired: gate?.dataset.gateExpired ?? null,
      approveGate: document.querySelector('[data-decide="approve"]')?.dataset.gateId ?? null,
      reservationId: reservation?.dataset.reservationId ?? null,
      reservationState: reservation?.dataset.reservationState ?? null,
      lease: lease?.dataset.leaseState ?? null,
      leaseText: lease?.textContent ?? null,
      attempt: attempt?.dataset.attemptState ?? null,
    };
  });
}

/** The same records as `task.read` answers them, reduced to what must survive. */
async function readRuntime(page, recordId) {
  const lineage = (await serverTask(page, recordId))?.proposals?.[0];
  const version = lineage?.versions?.[0];
  const reservation = lineage?.reservations?.[0];
  return {
    lineageId: lineage?.lineageId ?? null,
    lineageState: lineage?.state ?? null,
    versionId: version?.versionId ?? null,
    gateId: version?.gate?.id ?? null,
    gateState: version?.gate?.state ?? null,
    decisions: lineage?.decisions?.map((decision) => decision.id) ?? null,
    reservationId: reservation?.id ?? null,
    reservationState: reservation?.state ?? null,
    lease: reservation?.lease ?? null,
    attempt: reservation?.attempt ?? null,
  };
}

async function snapshot(page, task, name) {
  await openTask(page, task.href);
  return {
    href: task.href,
    recordId: task.recordId,
    screen: await drawnRuntime(page),
    server: await readRuntime(page, task.recordId),
    shot: await shot(page, name),
  };
}

/** Both tasks made and read before anything is stopped. */
async function runtimeRecordsBefore(run) {
  const { browser, database, admin, alpha, stamp } = run;
  const ada = await personOf(admin, alpha, 'ada@alpha.local');
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    await signIn(page, 'ada@alpha.local', 'alpha');
    const pending = await createTask(page, `Restart pending ${stamp}`);
    await propose(page, pending);

    const leased = await createTask(page, `Restart leased ${stamp}`);
    await propose(page, leased);
    await withDecideGrant(database, alpha, ada, async () => {
      await page.locator(APPROVE).click();
      await page.waitForSelector('[data-attempt-state]', { timeout: 15_000 });
    });
    const picked = await pickUp((await readRuntime(page, leased.recordId)).reservationId);

    return {
      picked,
      pending: await snapshot(page, pending, 'B6-runtime-before-pending-gate'),
      leased: await snapshot(page, leased, 'B6-runtime-before-lease-attempt'),
    };
  } finally {
    await context.close();
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The same two tasks, opened after the restart by a browser that has never seen them. */
async function runtimeRecordsAfter(run, before) {
  const context = await run.browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    await signIn(page, 'ada@alpha.local', 'alpha');
    const pending = await snapshot(page, before.pending, 'B6-runtime-after-pending-gate');
    const leased = await snapshot(page, before.leased, 'B6-runtime-after-lease-attempt');
    const was = before.pending;

    record({
      case: 'B6 a pending gate survives the restart',
      action: `before: ${was.shot.split('/').pop()}; restarted API and ${TARGET.container}, opened ${was.href} in a new context`,
      observed:
        `lineage ${String(pending.server.lineageId).slice(0, 8)}… version ` +
        `${String(pending.server.versionId).slice(0, 8)}… gate ${String(pending.server.gateId).slice(0, 8)}… ` +
        `${String(pending.server.gateState)} (screen ${String(pending.screen.gateState)}, expired=` +
        `${String(pending.screen.gateExpired)}), ${String(pending.server.decisions?.length)} decision(s); ` +
        `screen and task.read ${same(pending.screen, was.screen) && same(pending.server, was.server) ? 'unchanged' : 'CHANGED'}`,
      ok:
        was.server.lineageId !== null &&
        was.server.gateState === 'pending' &&
        same(pending.server, was.server) &&
        same(pending.screen, was.screen) &&
        pending.screen.lineageId === pending.server.lineageId &&
        pending.screen.versionId === pending.server.versionId &&
        pending.screen.gateState === 'pending' &&
        pending.screen.gateExpired === 'false' &&
        pending.server.decisions?.length === 0,
      shot: pending.shot,
    });

    const lease = leased.server.lease;
    const attempt = leased.server.attempt;
    record({
      case: 'B6 a lease and attempt survive the restart',
      action: `before: ${before.leased.shot.split('/').pop()}; approved, picked up by the alpha agent, restarted, reopened ${before.leased.href}`,
      observed:
        `reservation ${String(leased.server.reservationId).slice(0, 8)}… ${String(leased.server.reservationState)}, ` +
        `lease ${String(lease?.id).slice(0, 8)}… ${String(lease?.state)} fence ${String(lease?.fence)}, ` +
        `attempt ${String(attempt?.id).slice(0, 8)}… ${String(attempt?.state)}; screen draws lease ` +
        `${String(leased.screen.lease)} and attempt ${String(leased.screen.attempt)}; screen and task.read ` +
        `${same(leased.screen, before.leased.screen) && same(leased.server, before.leased.server) ? 'unchanged' : 'CHANGED'}`,
      ok:
        lease !== null &&
        attempt !== null &&
        same(leased.server, before.leased.server) &&
        same(leased.screen, before.leased.screen) &&
        leased.screen.reservationId === leased.server.reservationId &&
        leased.screen.lease === lease.state &&
        leased.screen.attempt === attempt.state &&
        leased.server.lineageId === leased.screen.lineageId &&
        leased.server.versionId === leased.screen.versionId,
      shot: leased.shot,
    });
  } finally {
    await context.close();
    const back = await handBack(before.picked);
    record({
      case: 'B6 the leased work is handed back after the restart',
      action: `the alpha agent handed lease ${String(before.picked.leaseId).slice(0, 8)}… fence ${String(before.picked.fence)} back to the restarted API`,
      observed: `HTTP ${String(back.status)}${back.status === 200 ? '' : ` ${back.text}`}`,
      ok: back.status === 200,
    });
  }
}
