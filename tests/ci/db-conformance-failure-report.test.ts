// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDatabase } from '../support/fresh-database.ts';

const root = resolve(import.meta.dirname, '../..');
const databaseUrl = process.env['DATABASE_URL'] ?? '';
const reachesDatabase = `
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

async function withSuite(
  source: string,
  check: (run: ReturnType<typeof spawnSync>) => void,
  removeReport = false,
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
    runFixture(source, check, database.appUrl, removeReport);
  } finally {
    await database.drop();
  }
}

function runFixture(
  source: string,
  check: (run: ReturnType<typeof spawnSync>) => void,
  fixtureUrl: string,
  removeReport: boolean,
): void {
  const directory = mkdtempSync(join(root, 'tests/ci/tmp-db-report-'));
  const scratch = mkdtempSync(join(tmpdir(), 'db-report-output-'));
  try {
    const suite = join(directory, 'assertion.test.ts');
    writeFileSync(suite, source);
    const manifest = join(directory, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ invariant: [relative(root, suite)] }));
    const args = ['scripts/db-conformance.mjs', '--manifest', manifest];
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

async function reportsSqlFailure(): Promise<void> {
  await withSuite(
    reachesDatabase.replace("toBe('db-report-actual-3917')", "toBe('db-report-expected-8246')"),
    (run) => {
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('1 test(s): 0 passed, 1 failed, 0 skipped');
      expect(run.stderr).toContain('assertion.test.ts');
      expect(run.stderr).toContain('database assertion detail compares the SQL result');
      expect(run.stderr).toContain('db-report-expected-8246');
      expect(run.stderr).toContain('db-report-actual-3917');
      expect(run.stderr).not.toContain('Their output is above');
    },
  );
}

async function redactsPrivateDetail(): Promise<void> {
  await withSuite(
    reachesDatabase +
      `
test('keeps diagnostic values private', () => {
  const databaseScheme = 'postgres';
  const databaseUser = 'reader';
  const databasePassword = 'synthetic-db-password';
  const databaseHost = 'db.invalid';
  const databaseName = 'proof';
  const syntheticDatabaseUrl = databaseScheme + '://' + databaseUser + ':' + databasePassword + '@' + databaseHost + '/' + databaseName;
  throw new Error('safe-actual-value ' + syntheticDatabaseUrl + ' token=synthetic-access-token /private/example/report-detail.txt ' + process.env.DB_REPORT_TEST_TOKEN);
});
`,
    (run) => {
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('keeps diagnostic values private');
      expect(run.stderr).toContain('safe-actual-value');
      expect(run.stderr).not.toContain('synthetic-db-password');
      expect(run.stderr).not.toContain('synthetic-access-token');
      expect(run.stderr).not.toContain('synthetic-env-credential-5159');
      expect(run.stderr).not.toContain('/private/example/report-detail.txt');
      expect(run.stderr).not.toContain(root);
    },
  );
}

async function boundsDetail(): Promise<void> {
  await withSuite(
    reachesDatabase +
      `
for (let index = 0; index < 6; index += 1) {
  test('bounded failure ' + index, () => {
    throw new Error('db-report-bound-marker ' + 'x'.repeat(20_000));
  });
}
`,
    (run) => {
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('7 test(s): 1 passed, 6 failed, 0 skipped');
      const detail = String(run.stderr).split(/\ndb-conformance: \d+ problem\(s\)/u)[0] ?? '';
      expect(detail).toContain('db-report-bound-marker');
      expect(detail).toContain('assertion detail truncated');
      expect(detail.length).toBeLessThan(17_000);
    },
  );
}

async function admitsSql(): Promise<void> {
  await withSuite(reachesDatabase, (run) => {
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('1 test(s): 1 passed, 0 failed, 0 skipped');
    expect(run.stderr).not.toContain('failed assertion');
  });
}

async function refusesSkip(): Promise<void> {
  await withSuite(reachesDatabase + "\ntest.skip('required SQL assertion', () => {});\n", (run) => {
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('2 test(s): 1 passed, 0 failed, 1 skipped');
    expect(run.stderr).toContain('database test(s) were skipped');
    expect(run.stderr).toContain('required SQL assertion');
  });
}

async function refusesMissingReport(): Promise<void> {
  await withSuite(
    reachesDatabase,
    (run) => {
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('a suite produced no readable result');
      expect(run.stderr).toContain('vitest never reported this file');
    },
    true,
  );
}

async function refusesNoSql(): Promise<void> {
  await withSuite(
    "import { expect, test } from 'vitest';\ntest('no SQL', () => expect(1 + 1).toBe(2));\n",
    (run) => {
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('1 test(s): 1 passed, 0 failed, 0 skipped');
      expect(run.stderr).toContain('without the database recording a single transaction');
    },
  );
}

describe.skipIf(databaseUrl === '')('database conformance failure reporting', () => {
  it(
    'prints the failed SQL assertion expected and actual values and still exits 1',
    reportsSqlFailure,
    120_000,
  );
  it('redacts credentials and private paths from assertion detail', redactsPrivateDetail, 120_000);
  it(
    'bounds assertion detail across multiple failures and reports truncation',
    boundsDetail,
    120_000,
  );
  it('admits a passing SQL assertion', admitsSql, 120_000);
  it('refuses a skipped assertion beside a passing SQL assertion', refusesSkip, 120_000);
  it('refuses a missing JSON report after a real SQL assertion', refusesMissingReport, 120_000);
  it('refuses a passing assertion that executes no SQL', refusesNoSql, 120_000);
});
