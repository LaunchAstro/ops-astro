// SPDX-License-Identifier: AGPL-3.0-only
// Which part of `local checks` and `isolation tests` each CI shard runs.
//
// Run whole, the two jobs took 35 and 29 minutes of the merge queue's 38, so
// ci.yml runs each as a matrix of shards and an aggregate job keeps the
// required check's name, as `database conformance` does (scripts/db-shards.ts).
// The runners and tests/ci/ci-shards.test.ts take the split from here, so the
// test proves the split the jobs run: every step, suite and test file in
// exactly one shard.
//
// isolation tests: the isolation suites and the ci.yml steps beside the runner,
// longest first onto the shard with the least time (db-shards' assignShards).
// scripts/db-conformance.mjs --isolation --shard runs the suites; a step runs
// through this script's wrapper below.
//
// local checks: every shard runs the build, which the tests read, and its share
// of the test files (vitest --shard, read by the sequencer in vitest.config.ts).
// Every other `pnpm check` step (scripts/check-steps.ts) and every ci.yml step
// after it runs in one shard. The steps are split first; the timed test files
// then fill the shards from the steps' loads, so the two together balance.
//
// tests/ci/ci-shard-plan.json holds the measured times. Only the balance reads
// them: a step or suite with no timing weighs the median of its kind, and a
// test file with none goes where a hash of its path puts it, so nothing new is
// left out. `fileUnder` is what such a file weighs in the balance test.
//
// Usage: node scripts/ci-shards.ts <check> --shard i/n --step <name> -- <command> [args...]
//        node scripts/ci-shards.ts <check> --shard i/n --step <name> --decide   (prints run or skip)
//   Runs the command when the step is in shard i, or says which shard runs it
//   and passes. A check or step it does not know is refused.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STEPS } from './check-steps.ts';
import {
  assignShards,
  parseShard,
  planItems,
  readPlan,
  shardWeight,
  type Part,
} from './db-shards.ts';
import { readIsolationSuites } from './named-suites.ts';

export const LOCAL = 'local checks';
export const ISOLATION = 'isolation tests';

/** The ci.yml steps after `pnpm check` in a `local checks` shard, each run in one shard. */
export const LOCAL_STEPS = [
  'container suites',
  'browser proofs',
  'semgrep settings',
  'public content snapshot',
  'promotion dry run',
  'inbox restart',
] as const;

/** The ci.yml steps beside the runner in an `isolation tests` shard, each run in one shard. */
export const ISOLATION_STEPS = [
  'service stop, two addresses',
  'seed boundaries',
  'seed redirect',
] as const;

/** The `pnpm check` steps every `local checks` shard runs: the build the tests read, and the tests, by file. */
export const EVERY_SHARD: readonly string[] = ['build', 'test'];

export interface ShardPlan {
  readonly isolation: Readonly<Record<string, number>>;
  readonly steps: Readonly<Record<string, number>>;
  readonly files: Readonly<Record<string, number>>;
  readonly fileUnder: number;
  readonly wallPerFileSecond: number;
}

const PLAN = 'tests/ci/ci-shard-plan.json';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSeconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** The keys of `value`, refusing an object holding any key but `keys`, or missing one. */
function exactly(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${what} is not an object`);
  const have = Object.keys(value).toSorted().join(', ');
  if (have !== [...keys].toSorted().join(', ')) throw new Error(`${what} holds ${have}`);
  return value;
}

/** A map of names to seconds, refusing anything else. */
function timings(value: unknown, what: string): Record<string, number> {
  if (!isObject(value)) throw new Error(`${what} is not an object`);
  for (const [name, seconds] of Object.entries(value))
    if (name === '' || !isSeconds(seconds)) throw new Error(`${what}: ${name} is not timed`);
  return value as Record<string, number>;
}

/** The plan, refusing a key it does not know or a value that is not seconds. */
export function readShardPlan(root: string): ShardPlan {
  const plan = exactly(
    JSON.parse(readFileSync(join(root, PLAN), 'utf8')),
    ['comment', 'isolation', 'local'],
    PLAN,
  );
  const local = exactly(
    plan['local'],
    ['steps', 'files', 'fileUnder', 'wallPerFileSecond'],
    `${PLAN} local`,
  );
  const { fileUnder, wallPerFileSecond } = local;
  if (!isSeconds(fileUnder) || !isSeconds(wallPerFileSecond) || wallPerFileSecond === 0)
    throw new Error(`${PLAN}: fileUnder and wallPerFileSecond take seconds`);
  return {
    isolation: timings(plan['isolation'], `${PLAN} isolation`),
    steps: timings(local['steps'], `${PLAN} local.steps`),
    files: timings(local['files'], `${PLAN} local.files`),
    fileUnder,
    wallPerFileSecond,
  };
}

/** The run items of `isolation tests`, as scripts/db-conformance.mjs --isolation builds them. */
export const isolationItems = (root: string): string[] =>
  planItems(
    readIsolationSuites(root).invariant,
    readPlan(join(root, 'tests/db/shard-plan.json')).parts,
  );

/** The isolation suites and steps split into `count` shards. */
export const isolationShards = (
  items: readonly string[],
  plan: ShardPlan,
  count: number,
): string[][] => assignShards([...items, ...ISOLATION_STEPS], plan.isolation, count);

/** The `pnpm check` steps one shard does not run whole, and the ci.yml steps after it. */
export const localSteps = (): string[] => [
  ...STEPS.map(([script]) => script).filter((script) => !EVERY_SHARD.includes(script)),
  ...LOCAL_STEPS,
];

/** The `local checks` steps split into `count` shards. */
export const localStepShards = (plan: ShardPlan, count: number): string[][] =>
  assignShards(localSteps(), plan.steps, count);

/**
 * The test files split into `count` shards. The plan's timed files go longest
 * first onto the shard with the least time so far, steps included, the lower
 * shard on a tie; any other file goes by a hash of its path. So a file's shard
 * depends on its path and the plan alone: a file one shard sees and another
 * does not moves no other file, and every file runs in exactly one shard.
 */
export function localFileShards(
  files: readonly string[],
  plan: ShardPlan,
  count: number,
): string[][] {
  const stepWeight = shardWeight(plan.steps);
  const loads = localStepShards(plan, count).map((steps) =>
    steps.reduce((sum, step) => sum + stepWeight(step), 0),
  );
  const timed = new Map<string, number>();
  const longestFirst = Object.entries(plan.files).toSorted(
    ([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const [file, seconds] of longestFirst) {
    const least = loads.indexOf(Math.min(...loads));
    loads[least] = (loads[least] ?? 0) + seconds * plan.wallPerFileSecond;
    timed.set(file, least);
  }
  const hashed = (file: string): number =>
    createHash('sha256').update(file).digest().readUInt32BE(0) % count;
  const shards = loads.map(() => [] as string[]);
  for (const file of new Set(files)) shards[timed.get(file) ?? hashed(file)]?.push(file);
  return shards.map((shard) => shard.toSorted());
}

/** The 1-based shard that runs `step` of `check`, refusing a check or step it does not know. */
export function shardOfStep(root: string, check: string, step: string, count: number): number {
  const plan = readShardPlan(root);
  let shards: string[][];
  if (check === LOCAL && (LOCAL_STEPS as readonly string[]).includes(step)) {
    shards = localStepShards(plan, count);
  } else if (check === ISOLATION && (ISOLATION_STEPS as readonly string[]).includes(step)) {
    shards = isolationShards(isolationItems(root), plan, count);
  } else {
    throw new Error(`"${step}" is not a step of "${check}"`);
  }
  return shards.findIndex((shard) => shard.includes(step)) + 1;
}

function main(argv: readonly string[]): number {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  const decide = own.length === 6 && own[5] === '--decide';
  const [check = '', shardFlag, shardText, stepFlag, step = ''] = own;
  if (
    shardFlag !== '--shard' ||
    stepFlag !== '--step' ||
    !(decide ? command.length === 0 && split === -1 : own.length === 5 && command.length > 0)
  ) {
    throw new Error('usage: <check> --shard i/n --step <name> (-- <command> | --decide)');
  }
  const shard: Part = parseShard(shardText);
  const owner = shardOfStep(resolve(import.meta.dirname, '..'), check, step, shard.count);
  const run = owner === shard.index;
  const where = `${check}: ${step}: ${run ? 'runs here' : 'runs in'} shard ${String(owner)}/${String(shard.count)}`;
  console.error(`ci-shards: ${where}`);
  if (decide) {
    process.stdout.write(run ? 'run\n' : 'skip\n');
    return 0;
  }
  if (!run) return 0;
  const [bin = '', ...args] = command;
  const child = spawnSync(bin, args, { stdio: 'inherit' });
  if (child.error !== undefined) throw child.error;
  return child.status ?? 1;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`ci-shards: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
