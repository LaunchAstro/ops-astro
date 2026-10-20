// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { expect, it } from 'vitest';
import { readNamedSuites } from '../../scripts/named-suites.ts';
import { readScopeMap } from '../../scripts/ci-scope.ts';
import { SHARDS_RUN } from './precheck-batch.ts';

it.each(['pull_request', 'merge_group', 'push', ''])(
  'runs the migration-order pin on %s without reading changed imports',
  (event) => {
    const run = spawnSync(
      process.execPath,
      [
        'scripts/ci-scope.ts',
        'pin and count tests',
        '--',
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      ],
      {
        env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: '' },
        encoding: 'utf8',
      },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toContain('tests/reads/task-rank-core-contract.test.ts');
  },
);

it('runs the pin job before the full-check label and keeps the database shards queue-only', () => {
  const workflow = parseDocument(readFileSync('.github/workflows/ci.yml', 'utf8')).toJS();
  const job = workflow.jobs['pin-tests'];
  expect(job).toBeDefined();
  expect(job.needs).toEqual(['gate']);
  expect(job.if).toBeUndefined();
  expect(job['continue-on-error']).toBeUndefined();
  const run = job.steps.find((step: { run?: string }) => step.run?.includes('ci-scope.ts'));
  expect(run.run).toBe("node scripts/ci-scope.ts 'pin and count tests' -- pnpm exec vitest run");
  expect(run.if).toBeUndefined();
  expect(workflow.on.pull_request.types).toEqual(
    expect.arrayContaining(['opened', 'synchronize', 'reopened']),
  );
  expect(workflow.on.pull_request.paths).toBeUndefined();
  expect(workflow.on.pull_request['paths-ignore']).toBeUndefined();
  expect(workflow.jobs['database-shard'].if).toBe(SHARDS_RUN);
});

it('lists every repository pin and catalogue count in the always-run settings', () => {
  const settings = readScopeMap('scripts/ci-scope.json');
  const named = readNamedSuites('.');
  const database = new Set(
    [...named.invariant, ...named.conformance].map((path) => path.split('#')[0]),
  );
  // Discover literal catalogue pins, static collection counts, migration readers and doc counts.
  // Numeric limits such as timeouts are not collection counts. Database suites stay queue-only.
  const contracts = globSync('tests/**/*.test.{ts,tsx}').filter((path) => {
    if (database.has(path)) return false;
    const source = readFileSync(path, 'utf8');
    return (
      /\bPINNED_[A-Z_]+/u.test(source) ||
      /expect\([A-Z][A-Z0-9_]+\)\.toHaveLength\(\d/u.test(source) ||
      /expect\([A-Z][A-Z0-9_]+\.(?:length|size)\)\.to(?:Be|Equal)\(\d/u.test(source) ||
      /\breadMigrations\(/u.test(source) ||
      (/new URL\(['"`][^'"`]*docs\//u.test(source) &&
        /\.toHaveLength\(\d|\.length\)\.to(?:Be|Equal)\(\d/u.test(source))
    );
  });
  expect(contracts.length).toBeGreaterThan(0);
  expect(contracts.filter((path) => !settings.alwaysRunTests.includes(path))).toEqual([]);
  expect(new Set(settings.alwaysRunTests).size).toBe(settings.alwaysRunTests.length);
});

// The repository-wide rules a merge group would otherwise test first, where one
// red rebuilds every group behind it: each read the whole tree, and none needs a
// database.
it.each([
  ['named-suite manifest', 'tests/db/named-suite-manifest.test.ts'],
  ['test files named by behaviour', 'tests/docs/test-files-by-behaviour.test.ts'],
  ['source comments', 'tests/docs/source-comments.test.ts'],
  ['source-comment cases', 'tests/docs/source-comment-cases-kept.test.ts'],
  [
    'column-grant contract',
    'tests/tenancy/column-grant-contract-names-every-migration-grant.test.ts',
  ],
])('runs the %s rule on every pull request', (_, path) => {
  const named = readNamedSuites('.');
  const database = [...named.invariant, ...named.conformance].map((s) => s.split('#')[0]);
  expect(readScopeMap('scripts/ci-scope.json').alwaysRunTests).toContain(path);
  expect(database).not.toContain(path);
});

it.each(['failure', 'cancelled', 'skipped'])(
  'the required local-checks result refuses pin tests that report %s',
  (pins) => {
    const workflow = parseDocument(readFileSync('.github/workflows/ci.yml', 'utf8')).toJS();
    const aggregate = workflow.jobs['local-checks'];
    expect(aggregate.needs).toContain('pin-tests');
    const step = aggregate.steps[0];
    expect(step.env.PINS).toBe('${{ needs.pin-tests.result }}');
    const run = spawnSync('bash', ['-eo', 'pipefail', '-c', step.run], {
      env: {
        PATH: process.env['PATH'],
        SHARDS: 'success',
        GATE: 'success',
        SCOPE: 'full',
        EVENT: 'pull_request',
        PINS: pins,
      },
      encoding: 'utf8',
    });
    expect(run.status).not.toBe(0);
  },
);
