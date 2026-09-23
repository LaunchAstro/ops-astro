// SPDX-License-Identifier: AGPL-3.0-only
//
// D06 and D03 on the mounted browser: every cell through the page's own client.
//
// `tests/acceptance/d06-generated.test.ts` runs the same grid on three
// in-process surfaces, and its `web` surface is the app's `OperationsClient`
// over an in-process `app.fetch`. That is not the mounted boundary. This runs
// the grid again in a real Chromium page, signed in through GoTrue, with every
// request made by the `OperationsClient` module Vite serves to that page
// (`throughClient`), against a real API on a real socket and a real Postgres.
//
// **Nothing here is a second copy of the grid.** The operations, the keys, the
// probe values and the durable comparison are imported from
// `tests/acceptance/d06-cases.ts`, and the positive recipes from
// `role-case-bodies.ts`, with the recipe's `asPerson` pointed at the page. So a
// cell is exactly the in-process cell on another surface: a valid control
// succeeds; the same valid request with the one field is refused with the typed
// code naming only that key, echoes nothing, leaves every public table as it
// was and writes one refused audit row; then that request without the field
// succeeds under a fresh operation identity.
//
// **D03's browser column** is the task screen's own Save: the screen's
// `submitEdit` call is sent, one protected field is added to its body on the
// wire, and the existing renderer has to draw the server's refusal, owning
// operation included. A missing rendering is recorded as a failure.
//
// Run (against an owned stack):
//   WEB_URL=http://127.0.0.1:5199 API_URL=http://127.0.0.1:8799 \
//   SHOT_DIR=.local/evidence/d06-mounted/run1 node tests/browser/d06-mounted.mjs
// `D06_ONLY=<operation>` narrows the grid to one operation while diagnosing;
// such a run says so and exits non-zero, because it is not the grid.

import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { connect, connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { PROTECTED_TASK_FIELDS } from '../../packages/core-records/src/tasks/spine.ts';
import {
  PAYLOAD_CELLS,
  TOP_LEVEL_CELLS,
  declarationFor,
  durableProbe,
  expectUnchanged,
  lastAudit,
  probeValue,
  roomToApprove,
} from '../acceptance/d06-cases.ts';
import { createPositiveBody } from '../acceptance/role-case-bodies.ts';
import { grantTo } from '../commands/fixture.ts';
import { d03Column } from './d06-mounted-d03.mjs';
import {
  API,
  SHOTS,
  VIEWPORT,
  WEB,
  closeQuietly,
  fromEnvFile,
  inOrder,
  root,
  servedIdentity,
  signIn,
  throughClient,
} from './harness.mjs';

const ADMIN_EMAIL = 'ada@alpha.local';
/** The two commands that write a record's generic fields (`d06-generated.test.ts`). */
const GENERIC_WRITES = new Set(['task.create', 'task.update']);
/** The pre-6f15252 grid the L6 packet counted against: 35 x (3 + 22) x mounted, less 3. */
const L6_MISSING = 872;

/**
 * Why a positive control needs something the page cannot make, per operation.
 * Every one of the 35 is still called from the page; only the precondition is
 * brought into existence elsewhere, and this says where.
 */
const PRECONDITION_OUTSIDE_PAGE = {
  'grant.revoke':
    'the grant it revokes is issued by tests/commands/fixture.ts grantTo on the application ' +
    'role, as d06-generated does: no page operation issues a grant',
  'delegation.revoke':
    'the delegation it revokes is opened by the alpha agent picking the reservation up on ' +
    '/api/a/b/alpha/task/pickup, as B6 does: an agent is not a page user',
};

/** The mounted cells: the in-process grid's `web` rows, each once. */
const cellsOf = (list, placement) =>
  list
    .filter((cell) => cell.surface === 'web')
    .map((cell) => ({ operation: cell.operation, key: cell.key, placement }));

const only = process.env.D06_ONLY;
const ALL_CELLS = [...cellsOf(TOP_LEVEL_CELLS, 'top'), ...cellsOf(PAYLOAD_CELLS, 'fields')];
const CELLS = only === undefined ? ALL_CELLS : ALL_CELLS.filter((c) => c.operation === only);

const expectedCodeOf = (cell) =>
  cell.placement === 'fields' && cell.key === 'source' && GENERIC_WRITES.has(cell.operation)
    ? 'SOURCE_SPOOFED'
    : 'FIELD_NOT_WRITABLE';

/** Where the agent signs in: the GoTrue this stack was configured with. */
const gotrue = () => {
  for (const line of readFileSync(`${root}.local/auth.env`, 'utf8').split('\n')) {
    const match = /^GOTRUE_URL=(.+)$/u.exec(line.trim());
    if (match) return match[1];
  }
  return 'http://127.0.0.1:54391';
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------

const head = (await import('node:child_process'))
  .execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  .trim();
const operations = [...new Set(ALL_CELLS.map((cell) => cell.operation))];
console.log(
  `D06 mounted plan: ${String(ALL_CELLS.length)} cells = ` +
    `${String(ALL_CELLS.filter((c) => c.placement === 'top').length)} top-level ` +
    `(${String(operations.length)} operations x ` +
    `${String(new Set(ALL_CELLS.filter((c) => c.placement === 'top').map((c) => c.key)).size)} keys) + ` +
    `${String(ALL_CELLS.filter((c) => c.placement === 'fields').length)} fields-nested; ` +
    `L6 counted ${String(L6_MISSING)} missing on its older 35 x 25 grid; head ${head}` +
    (only === undefined ? '' : `; NARROWED to ${only}: ${String(CELLS.length)} cells`),
);

const browser = await chromium.launch();
const admin = connectAsAdmin(fromEnvFile('DATABASE_ADMIN_URL'), { source: 'd06-mounted' });
const app = connect(fromEnvFile('DATABASE_URL'), { source: 'd06-mounted' });
const rows = [];
const cellFile = `${SHOTS}/d06-mounted-cells.jsonl`;
writeFileSync(cellFile, '');

try {
  const [{ id: alpha }] = await admin.execute(
    `select id from public.businesses where key = 'alpha'`,
  );
  const personOf = async (name) => {
    const found = await admin.execute(
      `select p.id as "personId", a.id as "actorId" from public.people p
         join public.actors a on a.person_id = p.id
        where p.business_id = $1 and p.display_name = $2 and a.kind = 'person'`,
      [alpha, name],
    );
    if (found.length !== 1) throw new Error(`d06-mounted: ${name} is not seeded once in alpha`);
    return found[0];
  };
  const mia = await personOf('Mia Chen');
  const noah = await personOf('Noah Patel');

  // The shape `d06-cases.ts` reads a harness through: an admin connection and the business.
  const harness = { world: { db: { admin }, alpha } };
  await roomToApprove(harness);
  const durable = await durableProbe(harness);

  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await signIn(page, ADMIN_EMAIL, 'alpha');
  const identity = await servedIdentity(page, 'd06-mounted');

  /** One call through the page's served client, answered as the recipes expect. */
  const inPage = async (name, body, options = {}) => {
    const read = declarationFor(name).kind === 'read';
    const { result } = await throughClient(page, { read, name, body, options });
    if (result !== null && typeof result === 'object' && 'unavailable' in result) {
      throw new Error(`d06-mounted: ${name} unavailable ${String(result.because)}`);
    }
    return result.ok === true
      ? { code: 'ok', body: result.value, names: [] }
      : { code: String(result.code), body: result, names: result.names ?? [] };
  };
  /** The in-process web surface's call, on the page: the body's own identity, if it has one. */
  const send = async (name, body) => {
    if (declarationFor(name).kind === 'read') return await inPage(name, body);
    return await inPage(name, body, { operationId: String(body.operationId) });
  };
  const freshTask = async (title) => {
    const created = await inPage('task.create', { fields: { title } });
    if (created.code !== 'ok') throw new Error(`d06-mounted: task.create refused ${created.code}`);
    return { id: String(created.body.recordId), revision: Number(created.body.revision) };
  };
  const alphaTask = await freshTask('a task every mounted cell can name');
  const positiveBody = createPositiveBody({
    alphaTaskId: alphaTask.id,
    assigneePersonId: mia.personId,
    asPerson: async (name, body) => await inPage(name, body),
    freshTask,
  });

  const agent = JSON.parse(readFileSync(`${root}.local/synthetic-agents.json`, 'utf8')).find(
    (entry) => entry.business === 'alpha',
  );
  let agentToken;
  const agentPickup = async (reservationId) => {
    agentToken ??= await fetch(`${gotrue()}/token?grant_type=password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: agent.email, password: agent.password }),
    }).then(async (response) => (await response.json()).access_token);
    const response = await fetch(`${API}/api/a/b/alpha/task/pickup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ operationId: randomUUID(), reservationId }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status !== 200) {
      throw new Error(`d06-mounted: agent pickup ${String(response.status)} ${body.code}`);
    }
    return (body.detail ?? body).delegationId;
  };

  /** A valid body, on work of its own, exactly as `d06-generated.test.ts` builds one. */
  const positive = async (name) => {
    const operationId = randomUUID();
    if (name === 'grant.revoke') {
      const grantId = await app.withBusiness(alpha, async (tx) => await grantTo(tx, noah, 'read'));
      return { operationId, grantId };
    }
    if (name === 'delegation.revoke') {
      const gate = await positiveBody(declarationFor('task.decide'));
      const decided = await inPage('task.decide', gate.body);
      if (decided.code !== 'ok') throw new Error(`d06-mounted: decide refused ${decided.code}`);
      const delegationId = await agentPickup(String(decided.body.detail.reservationId));
      return { operationId, delegationId };
    }
    const prepared = await positiveBody(declarationFor(name));
    if (!('body' in prepared)) throw new Error(`d06-mounted: ${name} has no recipe`);
    return declarationFor(name).kind === 'read' ? prepared.body : { operationId, ...prepared.body };
  };

  const runCell = async (cell) => {
    const code = expectedCodeOf(cell);
    const value = probeValue(cell.key);
    const inject = (body) =>
      cell.placement === 'top'
        ? { ...body, [cell.key]: value }
        : { ...body, fields: { ...body.fields, [cell.key]: value } };
    const row = {
      operation: cell.operation,
      field: cell.key,
      placement: cell.placement,
      surface: 'mounted-browser',
      expected: code,
      head,
    };
    try {
      const control = await send(cell.operation, await positive(cell.operation));
      row.control = control.code;
      if (control.code !== 'ok') throw new Error(`positive control answered ${control.code}`);

      const body = await positive(cell.operation);
      const before = await durable();
      const answer = await send(cell.operation, inject(body));
      row.code = answer.code;
      row.names = answer.names;
      if (answer.code !== code) throw new Error(`answered ${answer.code}, not ${code}`);
      if (JSON.stringify(answer.names) !== JSON.stringify([cell.key])) {
        throw new Error(`named ${JSON.stringify(answer.names)}`);
      }
      if (typeof value === 'string' && JSON.stringify(answer.body).includes(value)) {
        throw new Error('the refusal echoed the attempted value');
      }
      const after = await durable();
      const audit = await lastAudit(harness);
      const attempt = declarationFor(cell.operation).kind !== 'read';
      expectUnchanged(before, after, audit, { operation: cell.operation, code, attempt });
      if (
        cell.placement === 'top' &&
        JSON.stringify(audit.attempted) !== JSON.stringify({ [cell.key]: value })
      ) {
        throw new Error(`audit attempted ${JSON.stringify(audit.attempted)}`);
      }
      row.unchanged = true;
      row.audit = audit.refusal_code;

      const retry = attempt ? { ...body, operationId: randomUUID() } : body;
      const clean = await send(cell.operation, retry);
      row.retry = clean.code;
      if (clean.code !== 'ok') throw new Error(`clean retry answered ${clean.code}`);
      row.pass = true;
    } catch (error) {
      row.pass = false;
      row.failure = String(error?.message ?? error).slice(0, 400);
    }
    rows.push(row);
    writeFileSync(cellFile, `${JSON.stringify(row)}\n`, { flag: 'a' });
    if (!row.pass)
      console.log(`FAIL ${cell.operation} ${cell.placement}.${cell.key}: ${row.failure}`);
  };

  const started = Date.now();
  await inOrder(CELLS, runCell);
  const seconds = Math.round((Date.now() - started) / 1000);

  // Per-operation applicability and executed counts, from the rows that ran.
  const applicability = operations.map((operation) => {
    const mine = rows.filter((row) => row.operation === operation);
    return {
      operation,
      kind: declarationFor(operation).kind,
      calledFrom: 'page OperationsClient',
      precondition: PRECONDITION_OUTSIDE_PAGE[operation] ?? 'made through the page',
      cells: mine.length,
      passed: mine.filter((row) => row.pass).length,
      controls: mine.filter((row) => row.control === 'ok').length,
      retries: mine.filter((row) => row.retry === 'ok').length,
    };
  });
  for (const one of applicability.filter((a) => a.cells > 0)) {
    console.log(
      `D06 mounted ${one.operation}\tcells=${String(one.cells)}\tpass=${String(one.passed)}` +
        `\tcontrols=${String(one.controls)}\tretries=${String(one.retries)}` +
        (one.precondition === 'made through the page' ? '' : `\tprecondition: ${one.precondition}`),
    );
  }

  const d03 = await d03Column(page, inPage, admin, alpha);

  const passed = rows.filter((row) => row.pass).length;
  const pngs = readdirSync(SHOTS)
    .filter((name) => name.endsWith('.png'))
    .toSorted();
  const manifest = {
    head,
    web: WEB,
    api: API,
    identity,
    screenshots: Object.fromEntries(
      pngs.map((name) => [name, sha256(readFileSync(`${SHOTS}/${name}`))]),
    ),
  };
  writeFileSync(`${SHOTS}/MANIFEST.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    `${SHOTS}/d06-mounted-summary.json`,
    `${JSON.stringify({ head, cells: rows.length, passed, seconds, applicability, d03 }, null, 2)}\n`,
  );
  const d03Passed = d03.filter((one) => one.pass).length;
  console.log(
    `D06 mounted executed: ${String(passed)}/${String(rows.length)} cells passed in ${String(seconds)}s ` +
      `(planned ${String(CELLS.length)}); D03 browser ${String(d03Passed)}/${String(d03.length)}; ` +
      `${String(pngs.length)} screenshot(s) in MANIFEST.json; head ${head}`,
  );
  const green =
    only === undefined &&
    passed === ALL_CELLS.length &&
    rows.length === ALL_CELLS.length &&
    d03Passed === PROTECTED_TASK_FIELDS.length;
  process.exitCode = green ? 0 : 1;
} finally {
  await closeQuietly(app);
  await closeQuietly(admin);
  await browser.close();
}
