// SPDX-License-Identifier: AGPL-3.0-only
//
// The daily upkeep job (`backup.mjs expire`) also deletes second-factor codes
// past their horizon on the application database (migration 20261002105957), as the
// upkeep identity. Its count lands in the job's record; a failure there is
// recorded and never stops the backup expiry or the restore heartbeat; unset,
// the step is skipped and the record says so. It runs after the backup expiry
// and the heartbeat, its locks, statement and connect bounded, and its psql
// stopped at a deadline, so a stalled pooler costs the purge alone (security
// review M1). The store and the database are stand-ins here;
// tests/db/second-factor-codes-retention.test.ts runs both for real.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

type Reach = (url: string, script: string) => Promise<string>;
type Bounds = { connectSeconds?: number; timeoutMs?: number };
type ReachModule = {
  psqlOn: (network: string, bounds?: Bounds) => Reach;
  reachArgs: (network: string, names?: string[], options?: { init?: boolean }) => string[];
  reachEnv: (url: string, connectSeconds?: number) => Record<string, string>;
};
type Job = {
  expireBackups: (options: {
    storeUrl: string;
    upkeepUrl?: string;
    restoreHeartbeat?: string;
    send?: (address: string | undefined) => Promise<string>;
    reach?: Reach;
  }) => Promise<Record<string, unknown>>;
};
const JOB = '../../scripts/ops/backup.mjs';
const { expireBackups } = (await import(
  /* @vite-ignore */
  JOB
)) as Job;
const REACH = '../../scripts/ops/backup-store-reach.mjs';
const { psqlOn, reachArgs, reachEnv } = (await import(
  /* @vite-ignore */
  REACH
)) as ReachModule;
const PURGE =
  "set lock_timeout = '30s';\nset statement_timeout = '2min';\n" +
  'set role ops_astro_upkeep;\nselect ops.expire_second_factor_codes();\n';

const STORE = 'postgres://backups:5432/backups';
const UPKEEP = 'postgres://pooler.example.test:5432/postgres';
const send = () => Promise.resolve('sent');

/** A purge that answers only when the reach's deadline stops its psql, as psqlOn does. */
const hang = () =>
  new Promise<string>((_, reject) => {
    setTimeout(() => reject(new Error('stopped')), 100);
  });

/** `docker` arguments without the container's random name. */
const fixed = (args: string[]) => args.filter((arg) => !arg.startsWith('--name='));

/** The store answers one expired backup and a fresh drill; the database `codes`. */
const standIn =
  (codes: () => Promise<string>, sent: string[]): Reach =>
  async (url, script) => {
    sent.push(url === UPKEEP ? script : 'store');
    return url === UPKEEP ? await codes() : '{"count":1,"fresh":true}';
  };

it('records the count of second-factor codes the upkeep deleted, as the upkeep identity, its locks and statement bounded', async () => {
  const sent: string[] = [];
  const record = await expireBackups({
    storeUrl: STORE,
    upkeepUrl: UPKEEP,
    reach: standIn(() => Promise.resolve('3'), sent),
    send,
  });
  expect(record).toMatchObject({ outcome: 'recorded', count: 1, restoreHeartbeat: 'sent' });
  expect(record['secondFactorCodes']).toStrictEqual({ outcome: 'recorded', count: 3 });
  expect(sent).toContain(PURGE);
});

it('purges only once the backup expiry and the heartbeat are done, so a purge that hangs holds up neither', async () => {
  const done: string[] = [];
  const reach: Reach = async (url, script) => {
    done.push(url === UPKEEP ? 'purge' : 'store');
    return url === UPKEEP ? await hang() : await standIn(hang, [])(url, script);
  };
  const ping = () => (done.push('ping'), Promise.resolve('sent'));
  const record = await expireBackups({ storeUrl: STORE, upkeepUrl: UPKEEP, reach, send: ping });
  expect(done).toStrictEqual(['store', 'ping', 'purge']);
  expect(record).toMatchObject({ outcome: 'recorded', count: 1, restoreHeartbeat: 'sent' });
  expect(record['secondFactorCodes']).toStrictEqual({ outcome: 'failed' });
  const refused = await expireBackups({
    storeUrl: STORE,
    upkeepUrl: UPKEEP,
    reach: async (url) => (url === UPKEEP ? '2' : await Promise.reject(new Error('down'))),
  });
  expect(refused).toMatchObject({ outcome: 'failed', stage: 'store' });
  expect(refused['secondFactorCodes']).toStrictEqual({ outcome: 'recorded', count: 2 });
});

it('records a failed second-factor purge without stopping the backup expiry or the heartbeat', async () => {
  const record = await expireBackups({
    storeUrl: STORE,
    upkeepUrl: UPKEEP,
    reach: standIn(() => Promise.reject(new Error('refused at secret-host')), []),
    send,
  });
  expect(record).toMatchObject({ outcome: 'recorded', count: 1, restoreHeartbeat: 'sent' });
  expect(record['secondFactorCodes']).toStrictEqual({ outcome: 'failed' });
  expect(JSON.stringify(record)).not.toContain('secret-host');
});

it('skips the second-factor purge when its login is unset, and says so in the record', async () => {
  const sent: string[] = [];
  const record = await expireBackups({
    storeUrl: STORE,
    reach: standIn(() => Promise.resolve('3'), sent),
    send,
  });
  expect(sent).toStrictEqual(['store']);
  expect(record).toMatchObject({ outcome: 'recorded', count: 1 });
  expect(record['secondFactorCodes']).toStrictEqual({ outcome: 'not set' });
});

const bin = mkdtempSync(join(tmpdir(), 'backup-expire-codes-'));
afterAll(() => rmSync(bin, { recursive: true, force: true }));

it('refuses an upkeep login off the listed pooler as that step only, before reaching it', () => {
  const calls = join(bin, 'calls');
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho reached >> "${calls}"\nexit 99\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  const run = spawnSync(process.execPath, ['scripts/ops/backup.mjs', 'expire'], {
    encoding: 'utf8',
    env: {
      PATH: bin,
      BACKUP_RETENTION_URL: STORE,
      DATABASE_UPKEEP_URL: 'postgres://elsewhere.example.test:5432/postgres',
      OPS_EGRESS_POOLER_HOST: 'example.test',
      OPS_EGRESS_POOLER_PORT: '5432',
    },
  });
  // The store stand-in refuses too, so the job fails at the store, with the purge's own stage beside it.
  expect(JSON.parse(run.stdout)).toMatchObject({
    event: 'backup expired',
    outcome: 'failed',
    stage: 'store',
    secondFactorCodes: { outcome: 'failed', stage: 'config' },
  });
  expect(readFileSync(calls, 'utf8')).toBe('reached\n');
  expect(run.stdout).not.toContain('elsewhere');
});

it('the Vercel function refuses to start holding the upkeep login', async () => {
  const { GET } = await import('../../apps/api/function.ts');
  const saved = { ...process.env };
  process.env['DATABASE_UPKEEP_URL'] = UPKEEP;
  try {
    await expect(GET(new Request('https://ops.example.test/api/health'))).rejects.toThrow(
      'DATABASE_UPKEEP_URL set',
    );
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  }
});

it('a psql that never answers is stopped at the reach deadline; only a bounded reach names a connect bound', async () => {
  // psql is the container's PID 1 and deaf to SIGTERM, unless docker runs an init (`--init`)
  // that passes the signal on: the stand-in answers SIGTERM only when given `--init`.
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      'init=no',
      'for arg in "$@"; do [ "$arg" = --init ] && init=yes; done',
      `if [ $init = yes ]; then trap 'kill $child; exit 143' TERM; else trap '' TERM; fi`,
      '/bin/sleep 2 & child=$!',
      'wait $child',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'docker'), 0o755);
  const path = process.env['PATH'];
  process.env['PATH'] = bin;
  const started = performance.now();
  try {
    const bounded = psqlOn('none', { connectSeconds: 15, timeoutMs: 300 });
    await expect(bounded(UPKEEP, 'select 1;\n')).rejects.toThrow();
  } finally {
    process.env['PATH'] = path;
  }
  expect(performance.now() - started).toBeLessThan(1500);
  expect(reachEnv(UPKEEP, 15)['PGCONNECT_TIMEOUT']).toBe('15');
  expect(reachEnv(STORE)).not.toHaveProperty('PGCONNECT_TIMEOUT');
  expect(reachArgs('none', Object.keys(reachEnv(UPKEEP, 15)))).toContain('--env=PGCONNECT_TIMEOUT');
  expect(reachArgs('none', ['PGHOST'], { init: true })).toContain('--init');
  // The store's reach is as before: the same login names, no bound, no init.
  expect(fixed(reachArgs('none'))).toStrictEqual(
    fixed(reachArgs('none', Object.keys(reachEnv(STORE)))),
  );
  expect(reachArgs('none')).not.toContain('--init');
});

it('the job reaches the store unbounded as before, then the purge with its connect bound', () => {
  const calls = join(bin, 'bounds');
  writeFileSync(calls, '');
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh\necho "\${PGCONNECT_TIMEOUT:-none}" >> "${calls}"\nexit 99\n`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  const run = spawnSync(process.execPath, ['scripts/ops/backup.mjs', 'expire'], {
    encoding: 'utf8',
    env: {
      PATH: bin,
      BACKUP_RETENTION_URL: STORE,
      DATABASE_UPKEEP_URL: UPKEEP,
      OPS_EGRESS_POOLER_HOST: 'example.test',
      OPS_EGRESS_POOLER_PORT: '5432',
    },
  });
  expect(JSON.parse(run.stdout)).toMatchObject({
    outcome: 'failed',
    stage: 'store',
    secondFactorCodes: { outcome: 'failed' },
  });
  expect(readFileSync(calls, 'utf8')).toBe('none\n15\n');
});
