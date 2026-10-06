// SPDX-License-Identifier: AGPL-3.0-only
// `local checks` and `isolation tests` run as matrix shards, each split by
// measured time (scripts/ci-shards.ts, tests/ci/ci-shard-plan.json), as
// `database conformance` is (db-shards.test.ts). Splitting a gate is how a
// suite gets dropped quietly, so this proves the splits: every isolation suite
// and test file in exactly one shard, the runner and vitest each running
// exactly their shard of it, and the plan refusing what it cannot read.
// ci-shards-check.test.ts proves pnpm check's steps and the step wrapper;
// ci-shards-workflow.test.ts proves ci.yml.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestSpecification } from 'vitest/node';
import {
  ISOLATION_STEPS,
  isolationShards,
  localFileShards,
  localStepShards,
  localSteps,
  readShardPlan,
} from '../../scripts/ci-shards.ts';
import { shardWeight } from '../../scripts/db-shards.ts';
import config from '../../vitest.config.ts';
import {
  balance,
  ISOLATION_COUNT,
  items,
  LOCAL_COUNT,
  partitionProblems,
  plan,
  scratch,
} from './ci-shards.fixture.ts';
import { read, ROOT } from './merge-group-repo.ts';

const temp = scratch();

it('the plan reads the measured times, and refuses a key it does not know or a value that is not seconds', () => {
  expect(Object.keys(plan.isolation).length).toBeGreaterThan(100);
  expect(Object.keys(plan.files).length).toBeGreaterThan(100);
  // Every step the split weighs is timed, and nothing it does not weigh.
  expect(Object.keys(plan.steps).toSorted()).toStrictEqual(localSteps().toSorted());
  for (const step of ISOLATION_STEPS) expect(plan.isolation, step).toHaveProperty([step]);
  const real = JSON.parse(read('tests/ci/ci-shard-plan.json')) as Record<string, unknown>;
  const local = real['local'] as Record<string, unknown>;
  const bad: [string, unknown][] = [
    ['an unknown top key', { ...real, extra: {} }],
    ['a missing section', { comment: [], local }],
    ['an unknown local key', { ...real, local: { ...local, sharded: 3 } }],
    ['a negative time', { ...real, isolation: { 'tests/a.test.ts': -1 } }],
    ['a time as text', { ...real, local: { ...local, files: { 'tests/a.test.ts': '9' } } }],
    ['no wall factor', { ...real, local: { ...local, wallPerFileSecond: 0 } }],
    ['an array for an object', { ...real, isolation: [] }],
  ];
  for (const [what, body] of bad) {
    const root = temp();
    mkdirSync(join(root, 'tests/ci'), { recursive: true });
    writeFileSync(join(root, 'tests/ci/ci-shard-plan.json'), JSON.stringify(body));
    expect(() => readShardPlan(root), what).toThrow();
  }
});

describe('isolation tests', () => {
  it('every isolation suite and every step beside the runner in exactly one shard, near its share', () => {
    const shards = isolationShards(items, plan, ISOLATION_COUNT);
    expect(items.length).toBeGreaterThan(100);
    expect(partitionProblems(shards, [...items, ...ISOLATION_STEPS])).toStrictEqual([]);
    // Every shard runs suites, so the runner never meets an empty share.
    for (const shard of shards) expect(shard.some((item) => items.includes(item))).toBe(true);
    const { heaviest, bound } = balance(shards, shardWeight(plan.isolation));
    expect(heaviest).toBeLessThanOrEqual(bound);
    const added = 'tests/tenancy/named-later.test.ts';
    const later = isolationShards([...items, added], plan, ISOLATION_COUNT);
    expect(later.filter((shard) => shard.includes(added))).toHaveLength(1);
  });

  it('the runner runs exactly its shard of the split', () => {
    const listed = Array.from({ length: ISOLATION_COUNT }, (_, i) => {
      const shard = `${String(i + 1)}/${String(ISOLATION_COUNT)}`;
      const run = spawnSync(
        process.execPath,
        ['scripts/db-conformance.mjs', '--isolation', '--shard', shard, '--list'],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: { ...process.env, DATABASE_URL: 'postgres://unused@127.0.0.1:1/x' },
        },
      );
      // --list runs nothing, so it never exits 0: a stray --list in CI fails its shard.
      expect(run.status, run.stderr).toBe(3);
      return run.stdout.split('\n').filter(Boolean);
    });
    const split = isolationShards(items, plan, ISOLATION_COUNT).map((shard) =>
      shard.filter((item) => items.includes(item)),
    );
    expect(listed).toStrictEqual(split);
    expect(partitionProblems(listed, items)).toStrictEqual([]);
  }, 120_000);
});

/** Each local checks shard's files, as vitest's configured sequencer picks them from `files`. */
function sequenced(files: readonly string[]): Promise<string[][]> {
  const Sequencer = config.test?.sequence?.sequencer;
  expect(Sequencer, 'vitest.config.ts names a sequencer').toBeDefined();
  if (Sequencer === undefined) return Promise.resolve([]);
  const specs = files.map((file) => ({ moduleId: join(ROOT, file) }) as TestSpecification);
  return Promise.all(
    Array.from({ length: LOCAL_COUNT }, (_, i) => {
      const ctx = { config: { root: ROOT, shard: { index: i + 1, count: LOCAL_COUNT } } };
      return Promise.resolve(new Sequencer(ctx as never).shard(specs)).then((mine) =>
        mine.map((spec) => spec.moduleId.slice(ROOT.length + 1)),
      );
    }),
  );
}

/** Each file's shard in the local checks split of `list`. */
const owners = (list: readonly string[]) =>
  new Map(localFileShards(list, plan, LOCAL_COUNT).flatMap((s, i) => s.map((f) => [f, i])));

it('a test file’s shard depends on its path and the plan alone, never on the other files', () => {
  const files = [
    ...Object.keys(plan.files),
    ...Array.from({ length: 200 }, (_, i) => `tests/web/untimed-${String(i)}.test.ts`),
  ];
  const whole = owners(files);
  // A file one shard sees and another does not (a fixture a step writes, a pull
  // request's changed set) moves no other file, so none falls between shards.
  for (const view of [files.slice(1), files.slice(0, -1), [...files, 'tests/web/new.test.ts']]) {
    for (const [file, shard] of owners(view))
      if (whole.has(file)) expect(shard, file).toBe(whole.get(file));
  }
});

/** A test file's weight in the split: its wall share of the run, as scripts/ci-shards.ts weighs it. */
const fileWeight = (file: string): number =>
  (plan.files[file] ?? plan.fileUnder) * plan.wallPerFileSecond;

it('vitest’s sequencer splits the test files by measured time, every file in exactly one shard', async () => {
  const files = [
    ...Object.keys(plan.files),
    ...Array.from({ length: 500 }, (_, i) => `tests/web/untimed-${String(i)}.test.ts`),
  ];
  const picked = await sequenced(files);
  expect(partitionProblems(picked, files)).toStrictEqual([]);
  expect(picked.map((p) => p.toSorted())).toStrictEqual(localFileShards(files, plan, LOCAL_COUNT));
  // Steps and files together near each shard's share.
  const stepWeight = shardWeight(plan.steps);
  const loads = localStepShards(plan, LOCAL_COUNT).map(
    (steps, i) =>
      steps.reduce((t, s) => t + stepWeight(s), 0) +
      (picked[i] ?? []).reduce((t, f) => t + fileWeight(f), 0),
  );
  const total = loads.reduce((a, b) => a + b, 0);
  expect(Math.max(...loads)).toBeLessThanOrEqual((total / LOCAL_COUNT) * 1.1);
});
