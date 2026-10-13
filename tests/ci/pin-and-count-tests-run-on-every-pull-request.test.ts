// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { expect, it } from 'vitest';

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
  expect(workflow.jobs['database-shard'].if).toBe("github.event_name != 'pull_request'");
});

it('lists every repository pin and catalogue count in the always-run settings', () => {
  const settings = JSON.parse(readFileSync('scripts/ci-scope.json', 'utf8'));
  expect(settings.alwaysRunTests).toEqual(
    expect.arrayContaining([
      'tests/reads/task-rank-core-contract.test.ts',
      'tests/reads/repository-catalogue-and-migration-counts.test.ts',
      'tests/tenancy/migration-ids.test.ts',
      'tests/commands/runtime-codes.test.ts',
      'tests/connectors/aw-01-operations.test.ts',
      'tests/surfaces/read-names.test.ts',
      'tests/site/c80-catalogue.test.ts',
      'tests/site/c80-receipts.test.ts',
      'tests/sandbox/run-outcome-names-one-reason.test.ts',
      'tests/docs/c82-design-system-copy.test.ts',
      'tests/ci/structural-checks.test.ts',
      'tests/ci/pin-and-count-tests-run-on-every-pull-request.test.ts',
    ]),
  );
  expect(new Set(settings.alwaysRunTests).size).toBe(settings.alwaysRunTests.length);
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
