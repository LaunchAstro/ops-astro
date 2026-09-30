// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13's local run against the pinned target (`scripts/local/trace-target.ts
// up`): the composed exporter sends one run's content-free trace through
// custody as HTTP Basic; the operator retrieves it with the project pair; a
// replay from a reset cursor sends the same ids, which the store replaces on
// merge (until then the operator's read may show a row twice, never a new
// id); the
// trace is then expired as the retention rule does it, by the id derived from
// the run, and its absence is read back rather than trusted. Skipped unless
// `TRACE_TARGET_ENV_FILE` names a running target's settings, so it needs no
// account and never runs in the required checks; `down` destroys the target.

import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it as vitestIt } from 'vitest';
import { startTraceExporter, traceExportSettings } from '../../apps/api/trace-exporter.ts';
import { derivedId } from '../../packages/core-runtime/src/index.ts';
import { liveWork, rows } from './schedules-harness.ts';
import { noDatabase, t, useAw13World } from './aw-13-world.ts';

const envFile = process.env['TRACE_TARGET_ENV_FILE'];
const it = envFile === undefined || noDatabase ? vitestIt.skip : vitestIt;
if (envFile !== undefined) useAw13World('aw13_local');

const folder = mkdtempSync(join(tmpdir(), 'aw13-local-'));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

const setting = (name: string): string => {
  const line = readFileSync(envFile ?? '', 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith(`${name}=`));
  return line?.slice(name.length + 1) ?? '';
};

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Merge the target's event tables now, as ClickHouse does in its own time. */
function merge(): void {
  for (const table of ['events_core', 'events_full']) {
    execFileSync('docker', [
      'exec',
      'aw13-trace-target-clickhouse-1',
      'clickhouse-client',
      '--user',
      'clickhouse',
      '--password',
      setting('TRACE_TARGET_CLICKHOUSE_PASSWORD'),
      '--query',
      `optimize table ${table} final`,
    ]);
  }
}

/** The operator's read of one trace's observations, with the project pair. */
async function observations(traceId: string): Promise<{ id: string; traceId: string }[]> {
  const pair = `${setting('LANGFUSE_INIT_PROJECT_PUBLIC_KEY')}:${setting('LANGFUSE_INIT_PROJECT_SECRET_KEY')}`;
  const response = await fetch(
    `http://127.0.0.1:${setting('TRACE_TARGET_PORT')}/api/public/v2/observations?traceId=${traceId}&limit=100`,
    { headers: { authorization: `Basic ${Buffer.from(pair).toString('base64')}` } },
  );
  if (!response.ok) throw new Error(`operator read answered ${String(response.status)}`);
  return ((await response.json()) as { data: { id: string; traceId: string }[] }).data;
}

/** Poll until `done` holds of the trace's observations, or the deadline. */
async function until(
  traceId: string,
  done: (found: readonly { id: string }[]) => boolean,
): Promise<readonly { id: string }[]> {
  const deadline = Date.now() + 600_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling the target
    const found = await observations(traceId);
    if (done(found)) return found;
    if (Date.now() > deadline)
      throw new Error(`the target never showed it: ${String(found.length)}`);
    // eslint-disable-next-line no-await-in-loop -- polling the target
    await sleep(2_000);
  }
}

/** The composed exporter, on until the business is caught up. */
async function exportAll(business: string, key: Buffer): Promise<void> {
  const credentialsFile = join(folder, `credentials-${randomUUID()}.json`);
  const pair = `${setting('LANGFUSE_INIT_PROJECT_PUBLIC_KEY')}:${setting('LANGFUSE_INIT_PROJECT_SECRET_KEY')}`;
  const stored = { destination: 'trace_target', header: 'authorization', scheme: 'basic' };
  const entry = {
    ref: 'trace_key',
    kind: 'api_key',
    account: 'aw13-local',
    ...stored,
    value: pair,
  };
  writeFileSync(credentialsFile, JSON.stringify([entry]), { mode: 0o600 });
  const keyFile = join(folder, `key-${randomUUID()}`);
  writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  const settings = traceExportSettings({
    TRACE_EXPORT: 'on',
    TRACE_EXPORT_ORIGIN: `http://127.0.0.1:${setting('TRACE_TARGET_PORT')}`,
    TRACE_EXPORT_CREDENTIALS_FILE: credentialsFile,
    TRACE_EXPORT_KEY_FILE: keyFile,
  });
  if (settings.kind !== 'on') throw new Error('the switch did not turn export on');
  const exporter = await startTraceExporter(
    settings,
    t.alpha.db.app,
    () => Promise.resolve([business]),
    200,
  );
  try {
    for (let tries = 0; tries < 300; tries += 1) {
      // eslint-disable-next-line no-await-in-loop -- polling the cursor
      const [left] = await rows<{ n: string }>(
        t.alpha,
        `select count(*)::text as n from public.run_events ev
           left join public.trace_export_cursors c on c.business_id = ev.business_id
          where ev.business_id = $1 and (c.after_tx is null or (ev.tx, ev.id) > (c.after_tx, c.after_id))`,
        [business],
      );
      if (left?.n === '0') return;
      // eslint-disable-next-line no-await-in-loop -- polling the cursor
      await sleep(200);
    }
    throw new Error('the export did not catch up');
  } finally {
    await exporter.stop();
  }
}

const ids = (found: readonly { id: string }[]): string[] => found.map((one) => one.id).toSorted();

/** Delete one trace by its derived id, as the retention rule does. */
async function expire(traceId: string): Promise<Response> {
  const pair = `${setting('LANGFUSE_INIT_PROJECT_PUBLIC_KEY')}:${setting('LANGFUSE_INIT_PROJECT_SECRET_KEY')}`;
  return await fetch(`http://127.0.0.1:${setting('TRACE_TARGET_PORT')}/api/public/traces`, {
    method: 'DELETE',
    headers: {
      authorization: `Basic ${Buffer.from(pair).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ traceIds: [traceId] }),
  });
}

it('AW-13 local run: one trace, retrieved, deduped on replay, expired by rule', async () => {
  const s = t.alpha;
  const key = randomBytes(32);
  const title = `aw13-local-canary-${randomUUID()}`;
  const work = await liveWork(s, title, 1_000);
  const runId = String(work.picked['runId']);
  const traceId = derivedId(key, ['trace', s.business, runId], 32);

  const events = await rows<{ id: string }>(
    s,
    'select id from public.run_events where business_id = $1 and run_id = $2',
    [s.business, runId],
  );
  const spans = events
    .map((event) => derivedId(key, ['span', s.business, event.id], 16))
    .toSorted();

  await exportAll(s.business, key);
  const first = await until(traceId, (found) => found.length >= spans.length);
  expect(ids(first)).toEqual(spans);
  const body = JSON.stringify(first);
  for (const plain of [title, s.business, runId, work.taskId])
    expect(body.includes(plain)).toBe(false);

  await t.alpha.db.admin.execute('delete from public.trace_export_cursors where business_id = $1', [
    s.business,
  ]);
  await exportAll(s.business, key);
  await sleep(15_000);
  // The store keys each row by its id and replaces on merge: before the merge
  // the operator's read can show a replayed row twice, never a new id.
  expect([...new Set(ids(await observations(traceId)))]).toEqual(spans);
  merge();
  expect(ids(await observations(traceId))).toEqual(spans);

  // Expiry as the retention rule does it: the id is derived from the run, not
  // read from the target; the target's answer is not trusted, absence is read.
  const deleted = await expire(traceId);
  expect(deleted.ok).toBe(true);
  expect(await until(traceId, (found) => found.length === 0)).toEqual([]);
}, 1_500_000);
