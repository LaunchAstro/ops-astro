// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  noDatabase,
  REFERENCES,
  useUpgrade,
  s,
  VERSION,
  ALL,
  snapshot,
  rowFor,
  hostileRow,
  conversationRow,
  insertReference,
  refreshAttempt,
} from './run-side-reference-fixture.ts';

useUpgrade();
describe.skipIf(noDatabase)('run-reference upgrades preserve valid history', () => {
  it('keeps valid rows and applies every scope key atomically', async () => {
    const tables = ['attempts', 'handback_reports', 'run_events', 'outage_runs', 'model_calls'];
    await tables.reduce(async (previous, table) => {
      await previous;
      await insertReference(table, rowFor(table), true);
    }, Promise.resolve());
    await insertReference('model_calls', conversationRow(), true);
    const before = await snapshot();
    await s.db.closeSessions();
    expect((await applyMigrations(s.db.admin, ALL)).applied).toContain(VERSION);
    expect(await snapshot()).toEqual(before);
    await REFERENCES.reduce(async (previous, [table, column]) => {
      await previous;
      if (table === 'attempts') await refreshAttempt();
      await expect(insertReference(table, await hostileRow(table, column))).rejects.toMatchObject({
        code: '23503',
      });
    }, Promise.resolve());
  });
  it('the upgrade drill keeps stored rows through the scope migration', () => {
    const previous = ALL[ALL.findIndex((migration) => migration.version === VERSION) - 1];
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
