// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { seedSchedules } from './schedules-harness.ts';
import {
  s,
  other,
  insert,
  child,
  seedRunRows,
  snapshot,
  CROSS_RUN,
  setSchedules,
} from './run-side-rows-fixture.ts';
const VERSION = '20261007174204_run_bound_keys';
const ALL = readMigrations('migrations');
let beforeDirectory: string;

beforeAll(() => {
  if (databaseUrlFromEnvironment() === undefined) return;
  process.env['GATE_SIGNING_KEY_ID'] = 'test/run-bound-upgrade@1';
  process.env['GATE_SIGNING_SECRET'] = randomUUID();
  beforeDirectory = mkdtempSync(join(tmpdir(), 'run-bound-before-'));
  for (const file of readdirSync('migrations')) {
    if (file.endsWith('.sql') && file < `${VERSION}.sql`) {
      copyFileSync(join('migrations', file), join(beforeDirectory, file));
    }
  }
});

beforeEach(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  setSchedules(
    await seedSchedules(
      await createFreshDatabase({ part: 'runboundupgrade', migrationsDirectory: beforeDirectory }),
      'runboundupgrade',
      1_000_000,
    ),
  );
  await seedRunRows();
}, 60_000);

afterEach(async () => {
  await s?.db.drop();
});

afterAll(() => {
  if (beforeDirectory !== undefined) rmSync(beforeDirectory, { recursive: true, force: true });
});

async function refusedUpgrade(reference: string): Promise<void> {
  const before = await snapshot();
  const ledger = await s.db.admin.execute('select * from ops.schema_migrations order by version');
  await s.db.closeSessions();
  await expect(applyMigrations(s.db.admin, ALL)).rejects.toMatchObject({
    cause: {
      code: '23503',
      message: `run-bound references: ${reference} contains orphaned or cross-run rows`,
    },
  });
  expect(await snapshot()).toEqual(before);
  expect(await s.db.admin.execute('select * from ops.schema_migrations order by version')).toEqual(
    ledger,
  );
  expect(
    await s.db.admin.execute(
      `select conname from pg_constraint
          where conname in ('planned_steps_run_id_key', 'leases_run_id_key',
                            'attempts_run_id_key', 'reservations_run_id_key')`,
    ),
  ).toEqual([]);
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)('invalid run-bound history', () => {
  it.each(CROSS_RUN)(
    'stops before changing keys for existing cross-run %s.%s',
    async (table, column) => {
      await expect(
        insert(table, { ...child(table), [column]: other[column] }),
      ).resolves.toBeUndefined();
      await refusedUpgrade(`${table}.${column}`);
    },
  );

  it('stops before changing keys for an existing orphaned bootstrap read', async () => {
    await s.db.admin.execute(
      'alter table public.bootstrap_reads drop constraint bootstrap_reads_step_fkey',
    );
    await insert('bootstrap_reads', { ...child('bootstrap_reads'), step_id: randomUUID() });
    await refusedUpgrade('bootstrap_reads.step_id');
  });
});
describe.skipIf(databaseUrlFromEnvironment() === undefined)('valid run-bound history', () => {
  it('keeps same-run rows unchanged and refuses cross-run inserts after upgrading', async () => {
    await insert('bootstrap_reads', child('bootstrap_reads'));
    await insert('run_checks', child('run_checks'));
    await insert('model_calls', child('model_calls'));
    const before = await snapshot();
    await s.db.closeSessions();
    const applied = await applyMigrations(s.db.admin, ALL);
    expect(applied.applied).toContain(VERSION);
    expect(await snapshot()).toEqual(before);
    await expect(
      insert('bootstrap_reads', { ...child('bootstrap_reads'), step_id: other.step_id }),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(insert('bootstrap_reads', child('bootstrap_reads'))).resolves.toBeUndefined();
    await expect(insert('run_checks', child('run_checks'))).resolves.toBeUndefined();
    await expect(insert('model_calls', child('model_calls'))).resolves.toBeUndefined();
  });

  it('the upgrade drill keeps stored rows unchanged through the run-bound migration', () => {
    const at = ALL.findIndex((migration) => migration.version === VERSION);
    const previous = ALL[at - 1];
    expect(previous).toBeDefined();
    const run = spawnSync(
      process.execPath,
      ['scripts/local/upgrade-drill.mjs', '--from', previous?.version ?? '', '--json'],
      { encoding: 'utf8', env: process.env },
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const result: unknown = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '');
    expect(result).toMatchObject({
      ok: true,
      differences: [],
      applied: expect.arrayContaining([VERSION]),
    });
  }, 180_000);
});
