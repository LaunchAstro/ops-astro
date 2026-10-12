// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reachesDatabase, root, withSuite } from './db-conformance-report-fixture.ts';

const databaseUrl = process.env['DATABASE_URL'] ?? '';

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

const privateMarkers = [
  'synthetic-env-credential-5159',
  'synthetic-collection-secret',
  '/private/example/credentials.env',
];

async function redactsSuiteError(): Promise<void> {
  await withSuite(
    reachesDatabase +
      `
throw new Error('suite-error-marker password=synthetic-collection-secret ' + process.env.DB_REPORT_TEST_TOKEN + ' /private/example/credentials.env');
`,
    (run) => {
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('suite-error-marker');
      for (const marker of privateMarkers) expect(run.stderr).not.toContain(marker);
      expect(run.stderr).not.toContain(root);
    },
  );
}

async function redactsMissingReportOutput(): Promise<void> {
  await withSuite(
    reachesDatabase +
      `
process.stderr.write('missing-report-marker password=synthetic-collection-secret ' + process.env.DB_REPORT_TEST_TOKEN + ' /private/example/credentials.env\\n');
`,
    (run) => {
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('a suite produced no readable result');
      expect(run.stderr).toContain('missing-report-marker');
      for (const marker of privateMarkers) expect(run.stderr).not.toContain(marker);
    },
    true,
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
      expect(run.stderr).toContain(
        'transaction movement above measurement cost and a new client session',
      );
    },
  );
}

async function separatesDelayedReaderCost(): Promise<void> {
  await withSuite(
    reachesDatabase,
    (run) => {
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('1 test(s): 1 passed, 0 failed, 0 skipped');
    },
    false,
    true,
  );
  await withSuite(
    "import { expect, test } from 'vitest';\ntest('no SQL', () => expect(1 + 1).toBe(2));\n",
    (run) => {
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('1 test(s): 1 passed, 0 failed, 0 skipped');
      expect(run.stderr).toContain(
        'transaction movement above measurement cost and a new client session',
      );
    },
    false,
    true,
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
    'redacts credentials and private paths from an error raised outside any test',
    redactsSuiteError,
    120_000,
  );
  it(
    'redacts credentials and private paths from a suite output printed without a report',
    redactsMissingReportOutput,
    120_000,
  );
  it(
    'bounds assertion detail across multiple failures and reports truncation',
    boundsDetail,
    120_000,
  );
  it('admits a passing SQL assertion', admitsSql, 120_000);
  it('refuses a skipped assertion beside a passing SQL assertion', refusesSkip, 120_000);
  it('refuses a missing JSON report after a real SQL assertion', refusesMissingReport, 120_000);
  it('refuses a passing assertion that executes no SQL', refusesNoSql, 120_000);
  it(
    'counts delayed runner reads as measurement cost while still admitting real SQL',
    separatesDelayedReaderCost,
    120_000,
  );
});

describe('database conformance manifest', () => {
  it('refuses a manifest whose suite list is not an array of strings, before running anything', () => {
    const directory = mkdtempSync(join(tmpdir(), 'db-manifest-'));
    try {
      for (const body of [
        {
          invariant: ['tests/runtime/aw-01-durable-limit.test.ts'],
          conformance: 'tests/x.test.ts',
        },
        { invariant: ['tests/runtime/aw-01-durable-limit.test.ts', 7] },
        { invariant: 'tests/runtime/aw-01-durable-limit.test.ts' },
      ]) {
        const manifest = join(directory, 'manifest.json');
        writeFileSync(manifest, JSON.stringify(body));
        const run = spawnSync(
          process.execPath,
          ['scripts/db-conformance.mjs', '--manifest', manifest],
          {
            cwd: root,
            encoding: 'utf8',
            env: { ...process.env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/never' },
            timeout: 60_000,
          },
        );
        expect(run.status, JSON.stringify(body)).toBe(2);
        expect(run.stderr).toMatch(/must be an array of strings/u);
        expect(run.stderr).not.toContain('did not answer');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
