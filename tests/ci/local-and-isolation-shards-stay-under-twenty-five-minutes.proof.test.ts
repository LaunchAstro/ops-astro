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
import {
  isolationItems,
  isolationShards,
  localFileShards,
  localStepShards,
  readShardPlan,
} from '../../scripts/ci-shards.ts';
import { shardWeight } from '../../scripts/db-shards.ts';
import { ci } from './ci-shards.fixture.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const scale = (times: Record<string, number>) =>
  Object.fromEntries(Object.entries(times).map(([key, value]) => [key, value * 10]));

it('the completion proofs reject local and isolation shards above 35 minutes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sol-1484-budget-'));
  try {
    for (const file of [
      'scripts',
      'tests',
      'packages',
      'apps',
      '.github',
      'package.json',
      'vitest.config.ts',
    ]) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      cpSync(join(root, file), join(dir, file), { recursive: true });
    }
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const path = join(dir, 'tests/ci/ci-shard-plan.json');
    const original = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(
      path,
      JSON.stringify({
        ...original,
        isolation: scale(original.isolation),
        local: {
          ...original.local,
          steps: scale(original.local.steps),
          files: scale(original.local.files),
          fileUnder: original.local.fileUnder * 10,
        },
      }),
    );
    const plan = readShardPlan(dir);
    const localCount = ci.jobs['check']?.strategy?.matrix?.shard?.length ?? 0;
    const isolationCount = ci.jobs['isolation']?.strategy?.matrix?.shard?.length ?? 0;
    const isolationLoads = isolationShards(isolationItems(dir), plan, isolationCount).map((shard) =>
      shard.reduce((sum, item) => sum + shardWeight(plan.isolation)(item), 0),
    );
    const files = [
      ...Object.keys(plan.files),
      ...Array.from({ length: 500 }, (_, i) => `tests/web/untimed-${i}.test.ts`),
    ];
    const picked = localFileShards(files, plan, localCount);
    const localLoads = localStepShards(plan, localCount).map(
      (steps, i) =>
        steps.reduce((sum, item) => sum + shardWeight(plan.steps)(item), 0) +
        (picked[i] ?? []).reduce(
          (sum, file) => sum + (plan.files[file] ?? plan.fileUnder) * plan.wallPerFileSecond,
          0,
        ),
    );
    expect(
      Math.min(...isolationLoads),
      'every isolation shard exceeds 35 minutes before setup',
    ).toBeGreaterThan(35 * 60);
    expect(
      Math.min(...localLoads),
      'every local shard exceeds 35 minutes before setup and build',
    ).toBeGreaterThan(35 * 60);
    writeFileSync(
      join(dir, 'sol.config.mts'),
      "import base from './vitest.config.ts'; export default { ...base, test: { ...base.test, globalSetup: [] } };\n",
    );
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir };
    for (const key of ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'SUITE_PART', 'CHECK_SHARD'])
      delete env[key];
    const run = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        'sol.config.mts',
        '--reporter=verbose',
        'tests/ci/ci-shards.test.ts',
        'tests/ci/shard-counts-and-times-meet-the-ten-minute-job.proof.test.ts',
        '--testNamePattern=partition proofs|completion proof|near its share|sequencer splits',
      ],
      { cwd: dir, env, encoding: 'utf8', timeout: 60_000 },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.error, output).toBeUndefined();
    expect(output).toContain(
      'every isolation suite and every step beside the runner in exactly one shard, near its share',
    );
    expect(output).toContain(
      'vitest’s sequencer splits the test files by measured time, every file in exactly one shard',
    );
    expect(output).toContain('partition proofs exercise the shard counts CI actually runs');
    expect(
      run.status,
      `Local loads ${localLoads.map(Math.round)} s; isolation loads ${isolationLoads.map(Math.round)} s. The purported completion proofs passed:\n${output}`,
    ).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);
