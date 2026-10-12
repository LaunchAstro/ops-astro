// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { assignShards, planItems, readPlan, shardWeight } from '../../scripts/db-shards.ts';
import { readNamedSuites } from '../../scripts/named-suites.ts';
import { ci, ISOLATION_COUNT, LOCAL_COUNT } from './ci-shards.fixture.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

it('partition proofs exercise the shard counts CI actually runs', () => {
  expect(
    [LOCAL_COUNT, ISOLATION_COUNT],
    'The partition, sequencer, runner and wrapper proofs use these fixture counts.',
  ).toStrictEqual([
    ci.jobs['check']?.strategy?.matrix?.shard?.length,
    ci.jobs['isolation']?.strategy?.matrix?.shard?.length,
  ]);
});

// eslint-disable-next-line max-lines-per-function -- a review proof, kept as written
it('the completion proof rejects balanced database shards above 35 minutes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shard-times-duration-'));
  try {
    const files = [
      'package.json',
      '.github/workflows/ci.yml',
      'scripts/db-shards.ts',
      'scripts/named-suites.ts',
      'scripts/suite-files.ts',
      'scripts/ci-areas.ts',
      'tests/db/suites',
      'tests/db/suites-history.json',
      'tests/ci/db-shards.test.ts',
      'tests/ci/open-pull-request.ts',
      'tests/acceptance/d06-generated.test.ts',
      'tests/acceptance/d06-agent.test.ts',
      'tests/acceptance/d06-agent-fixture.ts',
      'tests/tenancy/restricted-calls-prefixes.test.ts',
    ];
    for (const file of files) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      cpSync(join(root, file), join(dir, file), { recursive: true });
    }
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const plan = readPlan(join(root, 'tests/db/shard-plan.json'));
    const seconds = Object.fromEntries(
      Object.entries(plan.seconds).map(([item, s]) => [item, s * 4]),
    );
    writeFileSync(join(dir, 'tests/db/shard-plan.json'), JSON.stringify({ ...plan, seconds }));
    writeFileSync(
      join(dir, 'vitest.config.mjs'),
      "export default { test: { environment: 'node', include: ['tests/ci/db-shards.test.ts'] } };\n",
    );
    const manifest = readNamedSuites(dir);
    const items = planItems([...manifest.invariant, ...manifest.conformance], plan.parts);
    const weight = shardWeight(seconds);
    const loads = assignShards(items, seconds, 30).map((shard) =>
      shard.reduce((sum, item) => sum + weight(item), 0),
    );
    expect(Math.min(...loads)).toBeGreaterThan(35 * 60);
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir };
    for (const key of ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'SUITE_PART', 'CHECK_SHARD'])
      delete env[key];
    const run = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--reporter=verbose',
        'tests/ci/db-shards.test.ts',
      ],
      { cwd: dir, env, encoding: 'utf8', timeout: 30_000 },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.error, output).toBeUndefined();
    expect(output).toContain('the run is split 30 ways, each shard near its share');
    expect(
      run.status,
      `Every database shard weighs ${Math.min(...loads).toFixed(1)} to ${Math.max(...loads).toFixed(1)} seconds, but the PR's completion proof reported:\n${output}`,
    ).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

it.each(['tests/acceptance/d06-agent.test.ts', 'tests/acceptance/d06-generated.test.ts'])(
  '%s registers every injection case once across its configured parts',
  // eslint-disable-next-line max-lines-per-function -- a review proof, kept as written
  (suite) => {
    const dir = mkdtempSync(join(tmpdir(), 'shard-times-collection-'));
    try {
      const config = join(dir, 'collection.config.mts');
      writeFileSync(
        config,
        `import base from ${JSON.stringify(join(root, 'vitest.config.ts'))};\n` +
          'export default { ...base, test: { ...base.test, globalSetup: [] } };\n',
      );
      const list = (part: string): string[] => {
        const output = join(dir, 'list.json');
        rmSync(output, { force: true });
        const run = spawnSync(
          process.execPath,
          [
            join(root, 'node_modules/vitest/vitest.mjs'),
            'list',
            '--config',
            config,
            '--no-staticParse',
            `--json=${output}`,
            suite,
          ],
          {
            cwd: root,
            encoding: 'utf8',
            timeout: 30_000,
            env: {
              ...process.env,
              DATABASE_URL: 'postgres://unused@127.0.0.1:1/collection_only',
              DATABASE_ADMIN_URL: 'postgres://unused@127.0.0.1:1/collection_only',
              SUITE_PART: part,
              TMPDIR: dir,
              TMP: dir,
              TEMP: dir,
            },
          },
        );
        expect(run.error, run.stderr).toBeUndefined();
        expect(run.status, run.stderr).toBe(0);
        const parsed: unknown = JSON.parse(readFileSync(output, 'utf8'));
        if (!Array.isArray(parsed)) throw new Error('vitest list did not return an array');
        return parsed
          .map((row: unknown) => {
            if (
              typeof row !== 'object' ||
              row === null ||
              !('name' in row) ||
              typeof row.name !== 'string'
            ) {
              throw new Error('vitest list did not return a test name');
            }
            return row.name;
          })
          .filter((name) => name.includes('refuses '));
      };
      const whole = list('');
      expect(whole.length).toBeGreaterThan(0);
      const count = readPlan(join(root, 'tests/db/shard-plan.json')).parts[suite];
      if (count === undefined) throw new Error(`${suite} has no configured parts`);
      const split = Array.from({ length: count }, (_, i) => list(`${i + 1}/${count}`)).flat();
      expect(split.toSorted()).toStrictEqual(whole.toSorted());
      expect(new Set(split).size).toBe(split.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);
