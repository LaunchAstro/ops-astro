// SPDX-License-Identifier: AGPL-3.0-only
//
// The runner's half of the migration ID rule (METHOD step 7, lane
// MIG-TIMESTAMP): every directory it reads holds well-formed IDs, each once,
// and a UTC timestamp ID sorts after every sequential one. The check before
// approval and in the queue is scripts/migration-ids.mjs, whose cases are
// tests/ci/migration-ids-cases.mjs. A pure suite: no database.

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readMigrations } from '../../packages/core-records/src/tenancy/migrate.ts';
import { migrationId } from '../../packages/core-records/src/tenancy/migration-ids.ts';

/** A directory holding one trivial migration per name. */
function directoryOf(names: readonly string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'migration-ids-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of names) writeFileSync(join(directory, `${name}.sql`), 'select 1;\n');
  return directory;
}

describe('the migration ID rule, in the runner', () => {
  it("reads main's migrations as they stand", () => {
    const onDisk = readdirSync('migrations').filter((name) => name.endsWith('.sql'));
    expect(readMigrations('migrations').map((m) => `${m.version}.sql`)).toStrictEqual(
      onDisk.toSorted(),
    );
  });

  it('orders a UTC timestamp ID after every four-digit one', () => {
    const directory = directoryOf(['20261002013000_stamped', '0002_two', '0001_one', '0111_last']);
    expect(readMigrations(directory).map((m) => m.version)).toStrictEqual([
      '0001_one',
      '0002_two',
      '0111_last',
      '20261002013000_stamped',
    ]);
  });

  it('refuses a directory holding two migrations with the same ID, naming both', () => {
    const directory = directoryOf(['0001_one', '0002_task_category', '0002_codes_retention']);
    expect(() => readMigrations(directory)).toThrow(
      /0002_codes_retention and 0002_task_category have the same ID/u,
    );
  });

  it('refuses two timestamp migrations with the same ID', () => {
    const directory = directoryOf(['0001_one', '20261002013000_a', '20261002013000_b']);
    expect(() => readMigrations(directory)).toThrow(/20261002013000_a and 20261002013000_b/u);
  });

  it('refuses a name that is neither a four-digit number nor a real UTC instant', () => {
    for (const name of [
      '84_short',
      '2026-10-02_dashes',
      '20261302013000_month_13',
      '20260230013000_february_30',
      '0100_Upper',
      'loose',
    ]) {
      expect(() => readMigrations(directoryOf(['0001_one', name])), name).toThrow(
        new RegExp(`${name} is not a migration name`, 'u'),
      );
    }
  });
});

describe('a migration ID', () => {
  it('is the digits before the first underscore', () => {
    expect(migrationId('0084_task_category')).toBe('0084');
    expect(migrationId('20261002013000_first_stamped')).toBe('20261002013000');
    expect(migrationId('loose')).toBeUndefined();
  });
});
