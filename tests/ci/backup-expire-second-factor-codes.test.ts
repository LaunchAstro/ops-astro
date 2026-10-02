// SPDX-License-Identifier: AGPL-3.0-only
//
// The daily upkeep job (`backup.mjs expire`) also deletes second-factor codes
// past their horizon on the application database (migration 0084), as the
// upkeep identity. Its count lands in the job's record; a failure there is
// recorded and never stops the backup expiry or the restore heartbeat; unset,
// the step is skipped and the record says so. The store and the database are
// stand-ins here; tests/db/second-factor-codes-retention.test.ts runs both for real.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

type Reach = (url: string, script: string) => Promise<string>;
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

const STORE = 'postgres://backups:5432/backups';
const UPKEEP = 'postgres://pooler.example.test:5432/postgres';
const send = () => Promise.resolve('sent');

/** The store answers one expired backup and a fresh drill; the database `codes`. */
const standIn =
  (codes: () => Promise<string>, sent: string[]): Reach =>
  async (url, script) => {
    sent.push(url === UPKEEP ? script : 'store');
    return url === UPKEEP ? await codes() : '{"count":1,"fresh":true}';
  };

it('records the count of second-factor codes the upkeep deleted, as the upkeep identity', async () => {
  const sent: string[] = [];
  const record = await expireBackups({
    storeUrl: STORE,
    upkeepUrl: UPKEEP,
    reach: standIn(() => Promise.resolve('3'), sent),
    send,
  });
  expect(record).toMatchObject({ outcome: 'recorded', count: 1, restoreHeartbeat: 'sent' });
  expect(record['secondFactorCodes']).toStrictEqual({ outcome: 'recorded', count: 3 });
  expect(sent).toContain('set role ops_astro_upkeep;\nselect ops.expire_second_factor_codes();\n');
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
      OPS_EGRESS_POOLER_HOST: 'pooler.example.test',
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
