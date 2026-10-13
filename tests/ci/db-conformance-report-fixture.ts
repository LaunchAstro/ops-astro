// SPDX-License-Identifier: AGPL-3.0-only
//
// One suite source run through scripts/db-conformance.mjs against a database
// of its own, for the runner's failure-report tests: the suite's file and
// manifest are written under tests/ci, the runner's stdout and stderr are
// handed to the check, and nothing it wrote is left behind.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { expect } from 'vitest';
import { createEmptyDatabase } from '../support/fresh-database.ts';

export const root: string = resolve(import.meta.dirname, '../..');
export const reachesDatabase: string = `
import { describe, expect, test } from 'vitest';
import pg from 'pg';

describe('database assertion detail', () => {
  test('compares the SQL result', async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query('select value from public.report_fixture');
      expect(rows[0].value).toBe('db-report-actual-3917');
    } finally {
      await client.end();
    }
  });
});
`;

function reportRemovalPreload(directory: string): string {
  const preload = join(directory, 'remove-report.mjs');
  writeFileSync(
    preload,
    `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
fs.readFileSync = function (path, ...args) {
  if (String(path).includes('hub-db-conformance-') && String(path).endsWith('/report.json')) {
    fs.rmSync(path, { force: true });
  }
  return read.call(this, path, ...args);
};
syncBuiltinESMExports();
`,
  );
  return preload;
}

function counterReadDelayPreload(directory: string): string {
  const preload = join(directory, 'delay-counter-read.mjs');
  writeFileSync(
    preload,
    `
import pg from 'pg';
const query = pg.Client.prototype.query;
let reads = 0;
pg.Client.prototype.query = function (statement, ...args) {
  if (typeof statement === 'string' && statement.includes('from pg_stat_database') && ++reads === 3) {
    return new Promise((resolve) => setTimeout(resolve, 1100)).then(() => query.call(this, statement, ...args));
  }
  return query.call(this, statement, ...args);
};
`,
  );
  return preload;
}

export async function withSuite(
  source: string,
  check: (run: ReturnType<typeof spawnSync>) => void,
  removeReport = false,
  delayCounterRead = false,
): Promise<void> {
  const database = await createEmptyDatabase({ part: 'report' });
  try {
    await database.admin.execute('create table public.report_fixture (value text not null)');
    await database.admin.execute('insert into public.report_fixture values ($1)', [
      'db-report-actual-3917',
    ]);
    await database.admin.execute(
      `grant select on public.report_fixture to "${database.loginRole}"`,
    );
    // Close setup before the child calibrates and reads this database's counter.
    await database.admin.close();
    runFixture(source, check, database.appUrl, removeReport, delayCounterRead);
  } finally {
    await database.drop();
  }
}

function runFixture(
  source: string,
  check: (run: ReturnType<typeof spawnSync>) => void,
  fixtureUrl: string,
  removeReport: boolean,
  delayCounterRead: boolean,
): void {
  const directory = mkdtempSync(join(root, 'tests/ci/tmp-db-report-'));
  const scratch = mkdtempSync(join(tmpdir(), 'db-report-output-'));
  try {
    const suite = join(directory, 'assertion.test.ts');
    writeFileSync(suite, source);
    const manifest = join(directory, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ invariant: [relative(root, suite)] }));
    const args = ['scripts/db-conformance.mjs', '--manifest', manifest];
    if (delayCounterRead) args.unshift('--import', counterReadDelayPreload(directory));
    if (removeReport) {
      const preload = reportRemovalPreload(directory);
      args.unshift('--import', preload);
    }
    const run = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: fixtureUrl,
        TMPDIR: scratch,
        DB_REPORT_TEST_TOKEN: 'synthetic-env-credential-5159',
      },
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    check(run);
    expect(readdirSync(scratch).filter((name) => name.startsWith('hub-db-conformance-'))).toEqual(
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}
