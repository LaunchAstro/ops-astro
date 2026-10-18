// SPDX-License-Identifier: AGPL-3.0-only
//
// #1708: the M5's trace export process on its own login. The process
// (`apps/trace-export/main.ts`), spawned as launchd runs it, exports a
// replay-fake run of its business to a stand-in target as a login that is a
// member of `ops_astro_trace` alone: the target gets timings, the outcome and
// the call counts, and none of the planted message, client address, credential
// or ids. With the target down the run still settles and the gap is recorded;
// with the process stopped the run settles, and started again it catches up.
// The login reads nothing of a run event but a span's cells, no record, client
// or business table, writes no run event, and in one business's transaction
// sees none of another's.

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asTraceRole } from '../../apps/trace-export/main.ts';
import { retainDeployment } from '../../apps/api/trace-exporter.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { derivedId } from '../../packages/core-runtime/src/index.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  handbackBody,
  liveWork,
  revisionOf,
  rows,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { ageLease, t, useAw13World } from '../runtime/aw-13-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();
const ROOT = resolve(import.meta.dirname, '../..');
const KEY = randomBytes(32);
const PASSWORD = `trace-login-${randomBytes(12).toString('hex')}`;

let folder = '';
let login = '';
let loginUrl = '';
let traceDb: Database;

if (serverUrl !== undefined) useAw13World('trace_login');

beforeAll(async () => {
  if (serverUrl === undefined) return;
  folder = mkdtempSync(join(tmpdir(), 'trace-login-'));
  const db = t.alpha.db;
  login = `${db.name}_trace`;
  await db.admin.execute(
    `create role "${login}" login password '${PASSWORD}' nosuperuser nocreatedb nocreaterole ` +
      `nobypassrls noinherit in role ops_astro_trace`,
  );
  await db.admin.execute(`grant connect on database "${db.name}" to "${login}"`);
  const url = new URL(db.appUrl);
  url.username = login;
  url.password = PASSWORD;
  loginUrl = url.toString();
  traceDb = connect(loginUrl);
}, 180_000);

afterAll(async () => {
  if (serverUrl === undefined) return;
  await traceDb.close();
  await t.alpha.db.admin.execute(`drop owned by "${login}"`);
  await t.alpha.db.admin.execute(`drop role "${login}"`);
  rmSync(folder, { recursive: true, force: true });
});

/** The settings file launchd's process reads, owner-only, for the target and this login. */
function settingsFile(business: string): string {
  const credentials = join(folder, `credentials-${randomUUID()}.json`);
  writeFileSync(
    credentials,
    JSON.stringify([
      {
        ref: 'trace_key',
        kind: 'api_key',
        account: 'trace-login',
        destination: 'trace_target',
        header: 'authorization',
        value: t.target.canary,
      },
    ]),
    { mode: 0o600 },
  );
  const key = join(folder, `key-${randomUUID()}`);
  writeFileSync(key, KEY.toString('hex'), { mode: 0o600 });
  const file = join(folder, `settings-${randomUUID()}.env`);
  const lines = [
    'TRACE_EXPORT=on',
    `TRACE_EXPORT_ORIGIN=${t.target.origin}`,
    `TRACE_EXPORT_CREDENTIALS_FILE=${credentials}`,
    `TRACE_EXPORT_KEY_FILE=${key}`,
    `DATABASE_TRACE_URL=${loginUrl}`,
    `TRACE_EXPORT_BUSINESSES=${business}`,
  ];
  writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  return file;
}

function startProcess(business: string) {
  let out = '';
  const child = spawn(process.execPath, ['--disable-sigusr1', 'apps/trace-export/main.ts'], {
    cwd: ROOT,
    env: { PATH: process.env['PATH'] ?? '', TRACE_EXPORT_SETTINGS_FILE: settingsFile(business) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  return {
    out: () => out,
    stop: async (): Promise<number | null> => {
      child.kill('SIGTERM');
      return await exited;
    },
  };
}

async function until(done: () => Promise<boolean> | boolean, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  // eslint-disable-next-line no-await-in-loop -- polling what the process did
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error('timed out');
    // eslint-disable-next-line no-await-in-loop -- polling what the process did
    await sleep(250);
  }
}

const traceOf = (s: Schedules, runId: unknown): string =>
  derivedId(KEY, ['trace', s.business, String(runId)], 32);
const received = (): string => t.target.received.join('\n');

async function replayCall(s: Schedules, leaseId: unknown): Promise<void> {
  await rows(
    s,
    `insert into public.model_calls
      (business_id, id, run_id, step_id, lease_id, version_id, reservation_id,
       operation_key, route_key, credential_kind, state, reserved_minor, actual_minor,
       accepted_at, ended_at)
     select l.business_id, $2, l.run_id, st.id, l.id, r.version_id, r.id,
            'scripted_replay', 'replay', 'replay', 'settled', 1, 1, now(), now()
       from public.leases l
       join public.reservations r on r.business_id = l.business_id and r.id = l.reservation_id
       join public.planned_steps st on st.business_id = l.business_id and st.run_id = l.run_id
      where l.business_id = $1 and l.id = $3 order by st.ordinal limit 1`,
    [s.business, randomUUID(), leaseId],
  );
}

/** A replay-fake run handed back, its title, comment and report planted with content. */
async function plantedRun(s: Schedules, planted: string) {
  const work = await liveWork(s, `trace-login ${planted}`, 1_000);
  appliedDetail(
    await asPerson(s, {
      command: 'task.comment',
      operationId: randomUUID(),
      recordId: work.taskId,
      expectedRevision: await revisionOf(s, work.taskId),
      body: planted,
      audience: 'internal',
    }),
    'task.comment',
  );
  await replayCall(s, work.picked['leaseId']);
  appliedDetail(
    await asAgent(
      s,
      { ...handbackBody(work.picked), report: { summary: planted } },
      String(work.picked['credential']),
    ),
    'task.handback',
  );
  return work;
}

async function runState(s: Schedules, runId: unknown): Promise<string | undefined> {
  const [row] = await rows<{ state: string }>(
    s,
    'select state from public.planned_runs where business_id = $1 and id = $2',
    [s.business, runId],
  );
  return row?.state;
}

async function gaps(s: Schedules): Promise<number> {
  const [row] = await rows<{ n: number }>(
    s,
    'select count(*)::int as n from public.trace_export_gaps where business_id = $1',
    [s.business],
  );
  return row?.n ?? -1;
}

/** One statement as the trace login, in `business`'s transaction, with or without its role. */
async function asLogin(business: string, text: string, role = true): Promise<string> {
  const database = role ? asTraceRole(traceDb) : traceDb;
  try {
    const found = await database.withBusiness(
      business as never,
      async (tx) => await tx.query(text),
    );
    return `rows ${String(found.length)}`;
  } catch (error) {
    return `refused ${String((error as { code?: string }).code)}`;
  }
}

describe.skipIf(serverUrl === undefined)('#1708: the trace export process on its own login', () => {
  it('exports a replay-fake run with timings, outcome and call counts, and nothing planted leaves', async () => {
    const s = t.alpha;
    const planted = `planted message https://client-${randomUUID()}.example/site`;
    const foreign = await plantedRun(t.bravo, `another business ${randomUUID()}`);
    const exporter = startProcess(s.business);
    try {
      const work = await plantedRun(s, planted);
      expect(await runState(s, work.picked['runId'])).not.toBe('running');
      await until(() => received().includes('"stringValue":"completed"'));
      const body = received();
      expect(body).toContain(`"traceId":"${traceOf(s, work.picked['runId'])}"`);
      expect(body).toMatch(/"startTimeUnixNano":"\d+","endTimeUnixNano":"\d+"/u);
      expect(body).toContain('"key":"ops-astro.usage.model_calls","value":{"intValue":"1"}');
      expect(body).toContain('"key":"ops-astro.usage.settled_calls","value":{"intValue":"1"}');
      for (const needle of [
        planted,
        'client-',
        t.target.canary,
        PASSWORD,
        work.taskId,
        String(work.picked['runId']),
        s.business,
        t.bravo.business,
        traceOf(t.bravo, foreign.picked['runId']),
      ]) {
        expect(body.includes(needle), needle).toBe(false);
        expect(exporter.out().includes(needle), needle).toBe(false);
      }
      const keys = new Set([...body.matchAll(/"key":"([^"]+)"/gu)].map((match) => match[1]));
      expect([...keys].toSorted()).toStrictEqual([
        'ops-astro.measurements.version',
        'ops-astro.outcome',
        'ops-astro.usage.model_calls',
        'ops-astro.usage.settled_calls',
        'sequence',
        'service.name',
        'stage',
      ]);
    } finally {
      expect(await exporter.stop()).toBe(0);
    }
  }, 180_000);

  it('a target that is down or a process that is stopped stops no run; the gap is recorded and caught up', async () => {
    const s = t.alpha;
    const before = await gaps(s);
    t.target.mode = 'down';
    let exporter = startProcess(s.business);
    const outage = await plantedRun(s, `outage ${randomUUID()}`);
    expect(await runState(s, outage.picked['runId'])).not.toBe('running');
    await until(async () => (await gaps(s)) > before);
    expect(await exporter.stop()).toBe(0);

    const stopped = await plantedRun(s, `stopped ${randomUUID()}`);
    expect(await runState(s, stopped.picked['runId'])).not.toBe('running');
    t.target.mode = 'ok';
    await ageLease(s);
    exporter = startProcess(s.business);
    try {
      for (const run of [outage, stopped]) {
        const trace = `"traceId":"${traceOf(s, run.picked['runId'])}"`;
        // eslint-disable-next-line no-await-in-loop -- each run's trace in turn
        await until(() => received().includes(trace));
      }
    } finally {
      expect(await exporter.stop()).toBe(0);
    }
  }, 240_000);

  it("reads only a span's cells, and runs retention, as its role in its own business", async () => {
    const own = t.alpha.business;
    const other = t.bravo.business;
    expect(await asLogin(own, 'select id from public.run_events', false)).toBe('refused 42501');
    expect(
      await asLogin(own, 'select id, run_id, kind, detail, tx from public.run_events'),
    ).toMatch(/^rows [1-9]/u);
    expect(
      await asLogin(own, `select id from public.run_events where business_id = '${other}'`),
    ).toBe('rows 0');
    for (const text of [
      'select task_id from public.run_events',
      'select actor_id from public.run_events',
      'select id from public.records',
      'select id from public.clients',
      'select id from public.businesses',
      'select id from public.planned_runs',
      'select operation_key from public.model_calls',
      'select holder_actor_id from public.leases',
      `insert into public.run_events (business_id) values ('${own}')`,
      'delete from public.trace_export_cursors',
      'delete from public.copy_registrations',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one statement at a time
      expect(await asLogin(own, text), text).toBe('refused 42501');
    }
    await retainDeployment(
      asTraceRole(traceDb),
      async () => await Promise.resolve([own]),
      KEY,
      t.target.expiry,
    );
  }, 60_000);
});
