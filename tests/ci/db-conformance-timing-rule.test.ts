// SPDX-License-Identifier: AGPL-3.0-only
//
// Register item 50a (owner, 18 October 2026), the runner's half of the
// timing-failure rule (#1857): scripts/db-conformance.mjs, against a database
// of its own, given the plan scripts/timing-rule.ts writes. On a merge group a
// suite the group does not touch, failing only on its tests, runs once more;
// a pass is logged as timing and a second failure blocks. A touched suite, a
// failure no test owns, and any other event never re-run. A quarantined suite
// the group does not touch sits out, and the nightly runs only those.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const root = resolve(import.meta.dirname, '../..');
const serverUrl = databaseUrlFromEnvironment();

/** A suite that reads the fixture table, then fails on the runs `failing` names (1 is its first). */
const suite = (failing: string, where: 'test' | 'file' | 'rejection' = 'test'): string => `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import pg from 'pg';

const counter = process.env.TIMING_RULE_COUNTER + '/' + import.meta.url.split('/').at(-1);
const runs = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
writeFileSync(counter, String(runs));
const fails = ${failing}.includes(runs);
${where === 'file' ? "if (fails) throw new Error('timing-rule fixture failed outside any test');" : ''}

test('reads the fixture table', async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query('select value from public.timing_fixture');
    expect(rows[0].value).toBe('timing-fixture-7412');
  } finally {
    await client.end();
  }
  ${where === 'rejection' ? "if (fails) void Promise.reject(new Error('timing-rule fixture rejection nobody handled'));" : ''}
  ${where === 'file' ? '' : "expect(fails, 'this run is one the fixture fails').toBe(false);"}
});
`;

const ONCE = '[1]';
const ALWAYS = '[1, 2, 3]';
const NEVER = '[]';

interface Plan {
  event: 'merge_group' | 'nightly' | 'other';
  touched?: string[];
  quarantined?: string[];
}

interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
  summary: string;
  ran: string[];
}

/** The plan file's text, with each fixture name as its path. */
function planText(plan: Plan | string, paths: Record<string, string>): string {
  if (typeof plan === 'string') return plan;
  return JSON.stringify({
    event: plan.event,
    run: '41000000001/1',
    pulls: ['1800', '1857'],
    changed: (plan.touched ?? []).map((name) => paths[name]),
    quarantined: (plan.quarantined ?? []).map((name) => ({
      test: paths[name],
      ticket: 1798,
      owner: 'Nathan-Mulligan',
      expires: '2026-11-01',
    })),
  });
}

/** The runner over the suites, with each path in its output written back as `<name>`. */
function runner(
  appUrl: string,
  suites: Record<string, string>,
  plan: Plan | 'none' | string,
  extra: readonly string[],
): Outcome {
  const directory = mkdtempSync(join(root, 'tests/ci/tmp-timing-rule-'));
  const scratch = mkdtempSync(join(tmpdir(), 'timing-rule-'));
  try {
    const paths: Record<string, string> = {};
    for (const [name, source] of Object.entries(suites)) {
      paths[name] = relative(root, join(directory, `${name}.test.ts`));
      writeFileSync(join(root, paths[name]), source);
    }
    const manifest = join(directory, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ invariant: Object.values(paths) }));
    const args = ['scripts/db-conformance.mjs', '--manifest', manifest, ...extra];
    if (plan !== 'none') {
      writeFileSync(join(scratch, 'plan.json'), planText(plan, paths));
      args.push('--timing-rule', join(scratch, 'plan.json'));
    }
    const summary = join(scratch, 'summary.md');
    writeFileSync(summary, '');
    const env = { DATABASE_URL: appUrl, TMPDIR: scratch, TIMING_RULE_COUNTER: scratch };
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...env, GITHUB_STEP_SUMMARY: summary },
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const named = (text: string): string =>
      Object.entries(paths).reduce((out, [name, path]) => out.replaceAll(path, `<${name}>`), text);
    const stdout = named(result.stdout);
    return {
      status: result.status,
      stdout,
      stderr: named(result.stderr),
      summary: named(readFileSync(summary, 'utf8')),
      ran: Object.keys(suites).filter((name) =>
        stdout.includes(`<${name}> moved the database counter`),
      ),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Run the suites through the runner against a fresh database holding the fixture table. */
async function run(
  suites: Record<string, string>,
  plan: Plan | 'none' | string,
  extra: readonly string[] = [],
): Promise<Outcome> {
  const database = await createEmptyDatabase({ part: 'timing' });
  try {
    await database.admin.execute('create table public.timing_fixture (value text not null)');
    await database.admin.execute(
      "insert into public.timing_fixture values ('timing-fixture-7412')",
    );
    await database.admin.execute(
      `grant select on public.timing_fixture to "${database.loginRole}"`,
    );
    // Close setup before the runner calibrates and reads this database's counter.
    await database.admin.close();
    return runner(database.appUrl, suites, plan, extra);
  } finally {
    await database.drop();
  }
}

async function reRunsAnUntouchedSuiteOnce(): Promise<void> {
  const out = await run({ flaky: suite(ONCE) }, { event: 'merge_group' });
  expect(out.status, out.stderr).toBe(0);
  expect(out.stdout).toContain('<flaky> failed in a suite this group does not touch');
  expect(out.summary).toContain('timing: <flaky>');
  expect(out.summary).toContain('reads the fixture table');
  expect(out.summary).toContain('run 41000000001/1');
  expect(out.summary).toContain('#1800, #1857');
  expect(out.stdout).toMatch(/^::warning title=timing::.*<flaky>/mu);
}

async function blocksASecondFailure(): Promise<void> {
  const out = await run({ flaky: suite(ALWAYS) }, { event: 'merge_group' });
  expect(out.status).toBe(1);
  expect(out.stderr).toContain('<flaky> failed again on its one re-run');
  expect(out.summary).not.toContain('timing:');
}

async function neverReRunsATouchedSuite(): Promise<void> {
  const out = await run({ flaky: suite(ONCE) }, { event: 'merge_group', touched: ['flaky'] });
  expect(out.status).toBe(1);
  expect(out.stdout).not.toContain('does not touch');
}

async function neverReRunsAFailureNoTestOwns(): Promise<void> {
  const out = await run({ flaky: suite(ONCE, 'file') }, { event: 'merge_group' });
  expect(out.status).toBe(1);
  expect(out.stdout).not.toContain('does not touch');
}

async function neverReRunsAFailureBesideAnUnhandledRejection(): Promise<void> {
  const out = await run({ flaky: suite(ONCE, 'rejection') }, { event: 'merge_group' });
  expect(out.status).toBe(1);
  expect(out.stdout).not.toContain('does not touch');
  expect(out.summary).not.toContain('timing:');
}

async function neverReRunsOutsideAGroup(plan: Plan | 'none'): Promise<void> {
  const out = await run({ flaky: suite(ONCE) }, plan);
  expect(out.status).toBe(1);
  expect(out.stdout).not.toContain('does not touch');
}

async function leavesOutAnUntouchedQuarantinedSuite(): Promise<void> {
  const out = await run(
    { steady: suite(NEVER), listed: suite(ALWAYS) },
    { event: 'merge_group', quarantined: ['listed'] },
  );
  expect(out.status, out.stderr).toBe(0);
  expect(out.ran).toStrictEqual(['steady']);
  expect(out.stdout).toContain('<listed> is left out of this merge group');
  expect(out.summary).toContain('<listed>: quarantined, #1798, owner Nathan-Mulligan');
}

async function aShardHoldingOnlyQuarantinedSuitesSitsOut(): Promise<void> {
  const out = await run(
    { listed: suite(ALWAYS) },
    { event: 'merge_group', quarantined: ['listed'] },
    ['--shard', '1/1'],
  );
  expect(out.status, out.stderr).toBe(0);
  expect(out.ran).toStrictEqual([]);
  expect(out.stdout).toContain('<listed> is left out of this merge group');
  expect(out.stderr).not.toContain('was given no suite');
}

async function runsATouchedQuarantinedSuite(): Promise<void> {
  const out = await run(
    { steady: suite(NEVER), listed: suite(ALWAYS) },
    { event: 'merge_group', quarantined: ['listed'], touched: ['listed'] },
  );
  expect(out.status).toBe(1);
  expect(out.ran.toSorted()).toStrictEqual(['listed', 'steady']);
}

async function nightlyRunsOnlyTheQuarantined(): Promise<void> {
  const out = await run(
    { steady: suite(NEVER), listed: suite(ONCE) },
    { event: 'nightly', quarantined: ['listed'] },
    ['--quarantined'],
  );
  expect(out.status).toBe(1);
  expect(out.ran).toStrictEqual(['listed']);
  expect(out.stdout).not.toContain('does not touch');
}

async function refusesAnUnreadablePlan(): Promise<void> {
  const out = await run({ steady: suite(NEVER) }, '{"event": "merge_group"');
  expect(out.status).toBe(2);
  expect(out.stderr).toContain('timing-rule plan');
  expect(out.ran).toStrictEqual([]);
}

describe.skipIf(serverUrl === undefined)('database conformance: the timing-failure rule', () => {
  const minutes = 240_000;
  it(
    're-runs an untouched suite once on a merge group and logs its pass as timing',
    reRunsAnUntouchedSuiteOnce,
    minutes,
  );
  it('blocks an untouched suite that fails again on its one re-run', blocksASecondFailure, minutes);
  it('never re-runs a suite the group touches', neverReRunsATouchedSuite, minutes);
  it('never re-runs a failure no test owns', neverReRunsAFailureNoTestOwns, minutes);
  it(
    'never re-runs a failed test beside an unhandled rejection',
    neverReRunsAFailureBesideAnUnhandledRejection,
    minutes,
  );
  it(
    'passes a shard whose whole share is quarantined and left out',
    aShardHoldingOnlyQuarantinedSuitesSitsOut,
    minutes,
  );
  it('never re-runs on a push', () => neverReRunsOutsideAGroup({ event: 'other' }), minutes);
  it('never re-runs without a plan', () => neverReRunsOutsideAGroup('none'), minutes);
  it(
    'leaves a quarantined suite the group does not touch out of the merge group',
    leavesOutAnUntouchedQuarantinedSuite,
    minutes,
  );
  it(
    'runs a quarantined suite the group touches, and it blocks',
    runsATouchedQuarantinedSuite,
    minutes,
  );
  it(
    'runs only the quarantined suites in the nightly run, with no re-run',
    nightlyRunsOnlyTheQuarantined,
    minutes,
  );
  it('refuses a plan it cannot read before running a suite', refusesAnUnreadablePlan, minutes);
});
