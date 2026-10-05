// SPDX-License-Identifier: AGPL-3.0-only
// The `local checks` shards' steps, by running the real scripts: pnpm check
// (scripts/check.mjs) runs its shard of the steps and, in every shard, the
// build and its share of the tests; scripts/ci-shards.ts runs each ci.yml step
// in exactly one shard and refuses what it does not know. The splits are
// ci-shards.test.ts's; ci.yml is ci-shards-workflow.test.ts's.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STEPS } from '../../scripts/check-steps.ts';
import {
  EVERY_SHARD,
  ISOLATION_STEPS,
  LOCAL_STEPS,
  localStepShards,
  localSteps,
} from '../../scripts/ci-shards.ts';
import {
  ISOLATION_COUNT,
  LOCAL_COUNT,
  partitionProblems,
  plan,
  scratch,
} from './ci-shards.fixture.ts';
import { ROOT } from './merge-group-repo.ts';

const temp = scratch();
const BASE = 'b'.repeat(40);
const scripts = STEPS.map(([script]) => script);

/** scripts/check.mjs over a pnpm that records each call, in `shard` or unsharded, on a group or a pull request. */
function pnpmCheck(shard?: string, pullRequest = false) {
  const dir = temp();
  const [log, pnpm, payload] = ['pnpm.log', 'pnpm.mjs', 'event.json'].map((f) => join(dir, f));
  writeFileSync(log ?? '', '');
  writeFileSync(
    pnpm ?? '',
    "import { appendFileSync } from 'node:fs';\n" +
      "appendFileSync(process.env.FAKE_PNPM_LOG, process.argv.slice(2).join(' ') + '\\n');\n",
  );
  const pull = { number: 7, head: { sha: 'a'.repeat(40) }, base: { sha: BASE, ref: 'main' } };
  writeFileSync(payload ?? '', JSON.stringify({ pull_request: pull }));
  const env: NodeJS.ProcessEnv = { ...process.env, npm_execpath: pnpm, FAKE_PNPM_LOG: log };
  for (const name of ['CHECK_SHARD', 'CHECK_SCOPE', 'CHECK_WEB_BUILD']) delete env[name];
  if (shard !== undefined) env['CHECK_SHARD'] = shard;
  if (pullRequest) Object.assign(env, { CHECK_SCOPE: 'local checks', GITHUB_EVENT_PATH: payload });
  env['GITHUB_EVENT_NAME'] = pullRequest ? 'pull_request' : 'merge_group';
  const cwd = temp();
  const out = spawnSync(process.execPath, [join(ROOT, 'scripts/check.mjs')], {
    cwd,
    env,
    encoding: 'utf8',
  });
  return {
    ...out,
    ran: readFileSync(log ?? '', 'utf8')
      .split('\n')
      .filter(Boolean),
  };
}

/** One shard's run: the build and the tests it must hold, and the steps it ran besides. */
function ownSteps(shard: string, whole: readonly string[]): string[] {
  const out = pnpmCheck(shard);
  expect(out.status, out.stderr).toBe(0);
  const tests = `run test --shard ${shard}`;
  // The build before the tests, as unsharded.
  expect(out.ran.indexOf('run build')).toBeGreaterThan(-1);
  expect(out.ran.indexOf('run build')).toBeLessThan(out.ran.indexOf(tests));
  const own = out.ran.filter((c) => c !== 'run build' && c !== tests);
  // In the order pnpm check gives them.
  expect(own).toStrictEqual(whole.filter((c) => own.includes(c)));
  return own.map((c) => c.slice('run '.length));
}

describe('pnpm check in a local checks shard', () => {
  it('splits every step but the build and the tests, and the later ci.yml steps, each into one shard', () => {
    expect(EVERY_SHARD).toStrictEqual(['build', 'test']);
    expect(localSteps()).toStrictEqual([
      ...scripts.filter((s) => !EVERY_SHARD.includes(s)),
      ...LOCAL_STEPS,
    ]);
    expect(partitionProblems(localStepShards(plan, LOCAL_COUNT), localSteps())).toStrictEqual([]);
  });

  it('runs its shard of the steps, and the build and its share of the tests in every shard', () => {
    const whole = pnpmCheck();
    expect(whole.status, whole.stderr).toBe(0);
    expect(whole.ran).toStrictEqual(scripts.map((script) => `run ${script}`));
    const ran = Array.from({ length: LOCAL_COUNT }, (_, i) =>
      ownSteps(`${String(i + 1)}/${String(LOCAL_COUNT)}`, whole.ran),
    );
    const later = new Set<string>(LOCAL_STEPS);
    expect(ran).toStrictEqual(
      localStepShards(plan, LOCAL_COUNT).map((s) => s.filter((step) => !later.has(step))),
    );
    const split = scripts.filter((s) => !EVERY_SHARD.includes(s));
    expect(partitionProblems(ran, split)).toStrictEqual([]);
  });

  it('on a pull request, takes its share of the tests the change reaches', () => {
    const shard = `2/${String(LOCAL_COUNT)}`;
    const light = pnpmCheck(shard, true);
    expect(light.status, light.stderr).toBe(0);
    const tests = `run test --shard ${shard}`;
    const reached = `run test --changed ${BASE} --passWithNoTests --shard ${shard}`;
    expect(light.ran).toStrictEqual(pnpmCheck(shard).ran.map((c) => (c === tests ? reached : c)));
  });

  it('refuses a shard it cannot read before any step runs', () => {
    for (const bad of ['', '0/3', '4/3', '3', 'a/b', ' 1/3']) {
      const out = pnpmCheck(bad);
      expect(out.status, bad).not.toBe(0);
      expect(out.ran, bad).toStrictEqual([]);
    }
  });
});

/** scripts/ci-shards.ts for one step, wrapping a command that says it ran, or with `tail` as given. */
function wrapped(check: string, shard: string, step: string, ...tail: string[]) {
  const command = tail.length > 0 ? tail : ['--', process.execPath, '-e', "console.log('ran')"];
  const args = ['scripts/ci-shards.ts', check, '--shard', shard, '--step', step, ...command];
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
}

/** For each shard of `count`, whether `step` ran there; each decision agreeing with the run. */
function ranIn(check: string, step: string, count: number): boolean[] {
  return Array.from({ length: count }, (_, i) => {
    const shard = `${String(i + 1)}/${String(count)}`;
    const out = wrapped(check, shard, step);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toMatch(
      new RegExp(`ci-shards: ${check}: ${step}: runs (here|in) shard \\d/${String(count)}`, 'u'),
    );
    const ran = out.stdout === 'ran\n';
    expect(wrapped(check, shard, step, '--decide').stdout).toBe(ran ? 'run\n' : 'skip\n');
    return ran;
  });
}

describe('scripts/ci-shards.ts, the step wrapper', () => {
  it.each([
    ['local checks', LOCAL_STEPS, LOCAL_COUNT],
    ['isolation tests', ISOLATION_STEPS, ISOLATION_COUNT],
  ] as const)(
    '%s: each step runs in exactly one shard, and passes saying where in the others',
    (name, steps, count) => {
      for (const step of steps)
        expect(ranIn(name, step, count).filter(Boolean), step).toHaveLength(1);
    },
  );

  it('passes on the command’s own exit status', () => {
    const owner =
      localStepShards(plan, LOCAL_COUNT).findIndex((s) => s.includes('inbox restart')) + 1;
    const shard = `${String(owner)}/${String(LOCAL_COUNT)}`;
    expect(wrapped('local checks', shard, 'inbox restart', '--', 'sh', '-c', 'exit 7').status).toBe(
      7,
    );
  });

  it.each([
    ['local checks', '--shard', '1/3', '--step', 'no such step', '--', 'true'],
    ['isolation tests', '--shard', '1/2', '--step', 'container suites', '--', 'true'],
    ['visual drift', '--shard', '1/2', '--step', 'container suites', '--', 'true'],
    ['local checks', '--shard', '4/3', '--step', 'inbox restart', '--', 'true'],
    ['local checks', '--step', 'inbox restart', '--shard', '1/3', '--', 'true'],
    ['local checks', '--shard', '1/3', '--step', 'inbox restart'],
    ['local checks', '--shard', '1/3', '--step', 'inbox restart', '--decide', '--', 'true'],
    ['local checks', '--shard', '1/3', '--step', 'inbox restart', 'extra', '--', 'true'],
  ])('refuses %s %s %s %s %s %s %s', (...args) => {
    const out = spawnSync(process.execPath, ['scripts/ci-shards.ts', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(`${String(out.status)} ${out.stdout}`).toBe('2 ');
  });
});
