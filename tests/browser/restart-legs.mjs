// SPDX-License-Identifier: AGPL-3.0-only
//
// W06 (b): browser rows after a real restart, on a lane's own stack.
//
// Before anything stops, ada makes four tasks through the page's client module
// (`throughClient`): a Request Changes round with version 1 sent back, an
// approved lineage then cancelled with `task.cancel`, a proposal left pending
// for a person to decide, and last a proposal whose gate lives
// `SHORT_GATE_SECONDS`. Then the API process this run started is stopped, the
// lane's Postgres container is restarted, the run waits on the database's own
// clock until the short gate has lapsed, and a new API process is started with
// `RECOVERY_BUSINESS_KEYS`, so startup recovery runs before it serves.
//
// After the restart a browser context that has never seen the tasks opens
// each one, and the existing task page draws:
//   (a) the lapsed gate as expired, while the stored row is still `pending`;
//   (b) version 2 of the round, proposed and decided through the client;
//   (c) the cancelled lineage's restart as a new lineage, the old one terminal;
//   (d) a decision made by clicking the page's own Approve button.
//
// W06 (c) and W01 are the connection-cut schedules of ruling 5, not here.
//
// The run owns exactly one API process at a time, started from this worktree
// and stopped by its own pid. Vite is the caller's, pointed at `API_URL` with
// `API_ORIGIN`. Nothing here runs against the live pair: the container must be
// named, and the live, datafix and `supabase_*` names and the shared ports are
// refused before anything starts.
//
//   RESTART_LEGS_PG_CONTAINER=<own container> WEB_URL=http://127.0.0.1:5197 \
//     API_URL=http://127.0.0.1:8797 node tests/browser/restart-legs.mjs

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import {
  API,
  DOCKER,
  VIEWPORT,
  WEB,
  fromEnvFile,
  outcomeOf,
  record,
  results,
  revisionOn,
  root,
  servedIdentity,
  serverTask,
  sh,
  signIn,
  standaloneStatus,
  throughClient,
} from './harness.mjs';

const SHORT_GATE_SECONDS = 20;
const PURPOSE = 'client_renewal_quote';
const RECOVERY_KEYS = process.env.RECOVERY_BUSINESS_KEYS ?? 'alpha,bravo';
const REFUSED_PORTS = new Set(['5190', '5198', '5199', '8790', '8793', '8798', '8799']);
const REFUSED_CONTAINERS = new Set(['ops-astro-local-pg', 'ops-astro-datafix-pg']);

const portOf = (url) => new URL(url).port;
const CONTAINER = process.env.RESTART_LEGS_PG_CONTAINER;
if (process.env.WEB_URL === undefined || process.env.API_URL === undefined) {
  throw new Error('restart-legs: set WEB_URL and API_URL to the lane stack');
}
for (const port of [portOf(WEB), portOf(API)]) {
  if (REFUSED_PORTS.has(port)) throw new Error(`restart-legs: ${port} is another stack's port`);
}
if (
  CONTAINER === undefined ||
  !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(CONTAINER) ||
  REFUSED_CONTAINERS.has(CONTAINER) ||
  CONTAINER.startsWith('supabase_')
) {
  throw new Error(`restart-legs: refusing container ${String(CONTAINER)}`);
}

const stamp = new Date().toISOString();
const head = sh('git', ['rev-parse', 'HEAD']).trim();
const RUN_DIR =
  process.env.SHOT_DIR ?? `${root}.local/restart-legs-browser/${stamp.replaceAll(':', '')}`;
mkdirSync(RUN_DIR, { recursive: true });
const PIDS = `${RUN_DIR}/pids`;
console.log(`restart-legs: head ${head}, web ${WEB}, api ${API}, container ${CONTAINER}`);

const settle = async (ms) => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

async function until(check, tries) {
  if (await check()) return true;
  if (tries <= 1) return false;
  await settle(1000);
  return await until(check, tries - 1);
}

async function healthy() {
  try {
    return (await fetch(`${API}/api/health`)).ok;
  } catch {
    return false;
  }
}

async function snap(page, name) {
  const file = `${RUN_DIR}/${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/** The API from this worktree, on `API_URL`'s port, with the recovery scope set. */
async function startApi(label) {
  if (await healthy()) throw new Error(`restart-legs: something already answers on ${API}`);
  const log = openSync(`${RUN_DIR}/api-${label}.log`, 'a');
  const child = spawn(process.execPath, ['apps/api/server.ts'], {
    cwd: root,
    env: { ...process.env, API_PORT: portOf(API), RECOVERY_BUSINESS_KEYS: RECOVERY_KEYS },
    stdio: ['ignore', log, log],
  });
  appendFileSync(PIDS, `${String(child.pid)}\n`);
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const up = await until(async () => !exited && (await healthy()), 30);
  if (!up) {
    child.kill('SIGTERM');
    throw new Error(`restart-legs: the API (${label}) did not answer`);
  }
  return {
    pid: child.pid,
    log: () => readFileSync(`${RUN_DIR}/api-${label}.log`, 'utf8'),
    stop: async () => {
      if (exited) return;
      const gone = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await gone;
    },
  };
}

const detailOf = (result) => result.value?.detail ?? result.value ?? {};

async function mutate(page, name, body, options) {
  const { result } = await throughClient(page, { name, body, options });
  if (result.ok !== true) {
    throw new Error(`${name} answered ${JSON.stringify(result).slice(0, 300)}`);
  }
  return detailOf(result);
}

async function openTask(page, task) {
  await page.goto(`${WEB}${task.href}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-task]', { timeout: 20_000 });
  await outcomeOf(page);
}

/** A task through the board's form, as B6 makes its own. */
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
  return { href, recordId, title };
}

async function propose(page, task, extra = {}) {
  await openTask(page, task);
  return await mutate(
    page,
    'task.propose',
    {
      recordId: task.recordId,
      purpose: PURPOSE,
      maximumMinor: 25_000,
      currency: 'AUD',
      payload: { step: PURPOSE },
      step: { kind: PURPOSE, payload: { step: PURPOSE } },
      ...extra,
    },
    { expectedRevision: await revisionOn(page) },
  );
}

const decide = async (page, proposed, decision) =>
  await mutate(page, 'task.decide', {
    gateId: proposed.gateId,
    versionId: proposed.versionId,
    decision,
    note: `restart-legs ${decision}`,
  });

/** What the task page draws for one lineage: its state and each version's gate. */
async function drawn(page, lineageId) {
  return await page.evaluate((id) => {
    const lineage = document.querySelector(`[data-lineage-id="${id}"]`);
    if (lineage === null) return null;
    return {
      state: lineage.dataset.lineageState,
      versions: [...lineage.querySelectorAll('[data-version-id]')].map((version) => ({
        version: version.dataset.version,
        gateState: version.querySelector('[data-gate-state]')?.dataset.gateState ?? null,
        gateExpired: version.querySelector('[data-gate-state]')?.dataset.gateExpired ?? null,
      })),
    };
  }, lineageId);
}

const lineagesOn = async (page) =>
  await page.evaluate(() =>
    [...document.querySelectorAll('[data-lineage-id]')].map((one) => ({
      id: one.dataset.lineageId,
      state: one.dataset.lineageState,
    })),
  );

/** Everything made before the restart, through the client, as ada. */
async function before(browser) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    await signIn(page, 'ada@alpha.local', 'alpha');
    const served = await servedIdentity(page, 'restart-legs-before');

    const round = await createTask(page, `Restart legs round ${stamp}`);
    const v1 = await propose(page, round);
    await decide(page, v1, 'request_changes');

    const cancelled = await createTask(page, `Restart legs cancelled ${stamp}`);
    const toCancel = await propose(page, cancelled);
    await decide(page, toCancel, 'approve');
    await openTask(page, cancelled);
    await mutate(page, 'task.cancel', {
      recordId: cancelled.recordId,
      lineageId: toCancel.lineageId,
      reason: 'restart-legs: withdrawn before the restart',
    });

    const pending = await createTask(page, `Restart legs decide ${stamp}`);
    const toDecide = await propose(page, pending);

    // Last, so its window starts as late as possible.
    const lapsing = await createTask(page, `Restart legs lapsing ${stamp}`);
    const short = await propose(page, lapsing, { expiresInSeconds: SHORT_GATE_SECONDS });
    await openTask(page, lapsing);
    const shotBefore = await snap(page, 'before-lapsing-gate');
    return {
      served,
      shotBefore,
      round: { task: round, v1 },
      cancelled: { task: cancelled, proposed: toCancel },
      pending: { task: pending, proposed: toDecide },
      lapsing: { task: lapsing, proposed: short },
    };
  } finally {
    await context.close();
  }
}

async function gateRow(admin, gateId) {
  const rows = await admin.execute(
    `select state, (expires_at <= now())::text as lapsed,
            (select count(*) from public.gate_decisions d
              where d.business_id = g.business_id and d.gate_id = g.id)::text as decisions
       from public.gates g where g.id = $1`,
    [gateId],
  );
  return rows[0];
}

/** Stop the API, restart the container, wait for the short gate to lapse, start a new API. */
async function restart(first, made) {
  const startedBefore = sh(DOCKER, ['inspect', '-f', '{{.State.StartedAt}}', CONTAINER]).trim();
  await first.stop();
  sh(DOCKER, ['restart', CONTAINER]);
  const ready = await until(() => {
    try {
      sh(DOCKER, ['exec', CONTAINER, 'pg_isready', '-q', '-U', 'postgres']);
      return true;
    } catch {
      return false;
    }
  }, 60);
  const startedAfter = sh(DOCKER, ['inspect', '-f', '{{.State.StartedAt}}', CONTAINER]).trim();
  const admin = connectAsAdmin(fromEnvFile('DATABASE_ADMIN_URL'), { source: 'restart-legs' });
  const lapsed = await until(
    async () =>
      (await gateRow(admin, made.lapsing.proposed.gateId).catch(() => undefined))?.lapsed ===
      'true',
    60,
  );
  const second = await startApi('after');
  const recovery = second
    .log()
    .split('\n')
    .filter((line) => line.startsWith('restart recovery'));
  record({
    case: 'RL0 API and Postgres restart',
    action: `API ${String(first.pid)} -> ${String(second.pid)}; ${CONTAINER} started ${startedBefore} -> ${startedAfter}`,
    observed: `ready=${String(ready)} lapsed-while-down=${String(lapsed)}; ${recovery.join('; ')}`,
    ok:
      ready &&
      lapsed &&
      second.pid !== first.pid &&
      startedAfter !== startedBefore &&
      recovery.some((line) => line.startsWith('restart recovery: alpha committed')),
  });
  return { admin, second };
}

async function after(browser, admin, made) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    await signIn(page, 'ada@alpha.local', 'alpha');

    // (a) The lapsed gate: drawn expired, stored pending, no decision.
    const lapsing = made.lapsing;
    await openTask(page, lapsing.task);
    const drawnLapsed = await drawn(page, lapsing.proposed.lineageId);
    const closed = await page.locator('[data-decide="closed"]').count();
    const stored = await gateRow(admin, lapsing.proposed.gateId);
    const readGate = (await serverTask(page, lapsing.task.recordId))?.proposals?.[0]?.versions?.[0]
      ?.gate;
    record({
      case: 'RL-a expired gate drawn after restart',
      action: `opened ${lapsing.task.href} in a new context`,
      observed: `screen ${JSON.stringify(drawnLapsed?.versions?.[0])}, controls closed=${String(closed)}; task.read ${String(readGate?.state)} expired=${String(readGate?.expired)}; stored ${stored?.state} decisions ${stored?.decisions}`,
      ok:
        drawnLapsed?.versions?.[0]?.gateState === 'expired' &&
        drawnLapsed?.versions?.[0]?.gateExpired === 'true' &&
        closed === 1 &&
        readGate?.state === 'expired' &&
        stored?.state === 'pending' &&
        stored?.decisions === '0',
      shot: await snap(page, 'RL-a-expired-gate'),
    });

    // (b) The Request Changes round: version 2 proposed and decided after the restart.
    const round = made.round;
    const v2 = await propose(page, round.task, { lineageId: round.v1.lineageId });
    await openTask(page, round.task);
    await decide(page, v2, 'approve');
    await openTask(page, round.task);
    const drawnRound = await drawn(page, round.v1.lineageId);
    const gates = Object.fromEntries(
      (drawnRound?.versions ?? []).map((one) => [one.version, one.gateState]),
    );
    record({
      case: 'RL-b Request Changes round decided',
      action: `v1 sent back before the restart; v2 proposed and approved through the client after it`,
      observed: `lineage ${String(drawnRound?.state)}, gates by version ${JSON.stringify(gates)}`,
      ok: gates['1'] === 'changes_requested' && gates['2'] === 'approved',
      shot: await snap(page, 'RL-b-round-decided'),
    });

    // (c) The cancelled lineage, restarted as a new one; the old one stays terminal.
    const cancelled = made.cancelled;
    await openTask(page, cancelled.task);
    const restarted = await mutate(page, 'task.restart', {
      recordId: cancelled.task.recordId,
      lineageId: cancelled.proposed.lineageId,
    });
    await openTask(page, cancelled.task);
    const lineages = await lineagesOn(page);
    const old = lineages.find((one) => one.id === cancelled.proposed.lineageId);
    const fresh = lineages.find((one) => one.id === restarted.lineageId);
    const freshGate = (await drawn(page, restarted.lineageId))?.versions?.[0]?.gateState;
    record({
      case: 'RL-c cancelled lineage and its restart',
      action: `task.restart through the client on ${cancelled.task.href}`,
      observed: `old ${String(old?.state)}, new ${String(fresh?.id).slice(0, 8)}… ${String(fresh?.state)} gate ${String(freshGate)}, restarts ${String(restarted.restartsLineageId).slice(0, 8)}…`,
      ok:
        old?.state === 'cancelled' &&
        fresh !== undefined &&
        fresh.state !== 'cancelled' &&
        freshGate === 'pending' &&
        restarted.restartsLineageId === cancelled.proposed.lineageId,
      shot: await snap(page, 'RL-c-restarted-lineage'),
    });

    // (d) A decision made by clicking the page's own Approve button.
    const pending = made.pending;
    await openTask(page, pending.task);
    await page
      .locator(`[data-decide="approve"][data-gate-id="${pending.proposed.gateId}"]`)
      .click();
    await page.waitForSelector('[data-reservation-id]', { timeout: 15_000 }).catch(() => undefined);
    await openTask(page, pending.task);
    const drawnDecided = await drawn(page, pending.proposed.lineageId);
    const reservation = await page.locator('[data-reservation-id]').count();
    const decidedRow = await gateRow(admin, pending.proposed.gateId);
    record({
      case: 'RL-d browser-driven decision',
      action: `clicked Approve on ${pending.task.href} after the restart`,
      observed: `screen gate ${String(drawnDecided?.versions?.[0]?.gateState)}, reservations drawn ${String(reservation)}; stored ${decidedRow?.state} decisions ${decidedRow?.decisions}`,
      ok:
        drawnDecided?.versions?.[0]?.gateState === 'approved' &&
        reservation >= 1 &&
        decidedRow?.state === 'approved' &&
        decidedRow?.decisions === '1',
      shot: await snap(page, 'RL-d-decided'),
    });
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch();
let api;
let admin;
let made;
let status = 1;
try {
  api = await startApi('before');
  made = await before(browser);
  const restarted = await restart(api, made);
  api = restarted.second;
  admin = restarted.admin;
  await after(browser, admin, made);
} catch (error) {
  record({ case: 'RL run', action: 'the run', observed: String(error).slice(0, 400), ok: false });
} finally {
  await api?.stop().catch(() => undefined);
  await admin?.close().catch(() => undefined);
  await browser.close();
  status = standaloneStatus('restart-legs', ['RL0', 'RL-a', 'RL-b', 'RL-c', 'RL-d']);
  writeFileSync(
    `${RUN_DIR}/MANIFEST.json`,
    `${JSON.stringify(
      {
        head,
        dirty: sh('git', ['status', '--porcelain']).trim() !== '',
        stamp,
        web: WEB,
        api: API,
        container: CONTAINER,
        recoveryKeys: RECOVERY_KEYS,
        served: made?.served ?? null,
        rows: results,
        exit: status,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`restart-legs: evidence in ${RUN_DIR}`);
}
process.exit(status);
