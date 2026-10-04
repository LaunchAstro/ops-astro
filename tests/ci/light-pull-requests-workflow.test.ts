// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SPEED, light pull requests, the workflow's side (the scripts' side is
// light-pull-requests.test.ts). Every required check still reports under its own name on a pull
// request and on a group; the shards behind `database conformance` skip pull requests alone, and
// the aggregate passes their skip on a pull request alone; `local checks` and `isolation tests`
// defer their heavy steps through scripts/ci-scope.ts; and planted forms of each go red. The
// workflows are read with a YAML parser, as merge-group-jobs.test.ts reads them.

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { read } from './merge-group-repo.ts';

type Env = Record<string, string>;
type Step = { name?: string; if?: unknown; run?: string; uses?: string; env?: Env };
type Job = { name?: string; if?: unknown; needs?: unknown; steps?: Step[] };
type Workflow = { on?: Record<string, unknown>; jobs: Record<string, Job> };

const CI = '.github/workflows/ci.yml';
const REVIEW = '.github/workflows/review-evidence.yml';
const SKIPS_PULL_REQUESTS = "github.event_name != 'pull_request'";
const NOT_ON_PUSH = "github.event_name != 'push'";
const ONLY_ON_PUSH = 'Public content and metadata from the root';
/** The required checks that run in full on a pull request; none may be deferred or scoped. */
const FULL_ON_PR = new Set([
  'contamination gate',
  'gitleaks over the full history',
  'OSI licence allowlist',
  'commit messages and provenance',
  'pull request size',
  'review evidence for this revision',
  'database conformance gate',
  'dependency audit',
  'static analysis',
  'command parity',
]);
/** The checks whose heavy part a pull request defers to the merge queue. */
const DEFERRED = new Set(['local checks', 'isolation tests']);
const required = (
  JSON.parse(read('.github/required-checks.json')) as {
    required_status_checks: { context: string; integration_id: number }[];
  }
).required_status_checks
  .filter((c) => c.integration_id === 15368)
  .map((c) => c.context);

/** A condition as GitHub evaluates it: `${{ x }}` and `x` are the same expression. */
const condition = (value: unknown) =>
  typeof value === 'string' ? value.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/u, '$1') : value;
const load = (path: string): Workflow =>
  parseDocument(read(path), { merge: true, uniqueKeys: true }).toJS({
    maxAliasCount: 100,
  }) as Workflow;
const queueOnlyOf = (): string[] =>
  (JSON.parse(read('scripts/ci-scope.json')) as { queueOnly?: string[] }).queueOnly ?? [];
const problemsNow = (ci: Workflow) => workflowProblems(ci, load(REVIEW), queueOnlyOf());
const aggregateStep = (ci: Workflow) => ci.jobs['database']?.steps?.[0];

/** Each required check with no job, a workflow that skips a pull request or a group, or a condition. */
function requiredProblems(workflows: Workflow[]): string[] {
  const problems: string[] = [];
  for (const name of required) {
    const owner = workflows.find((w) => Object.values(w.jobs).some((j) => j.name === name));
    const job = owner && Object.values(owner.jobs).find((j) => j.name === name);
    if (owner === undefined || job === undefined) {
      problems.push(`${name}: no job reports it`);
      continue;
    }
    for (const event of ['pull_request', 'merge_group'])
      if (!(event in (owner.on ?? {}))) problems.push(`${name}: its workflow skips ${event}`);
    const cond = condition(job.if);
    if (![undefined, 'always()', NOT_ON_PUSH].includes(cond as string))
      problems.push(`${name}: if: ${String(cond)}`);
  }
  return problems;
}

/** Each step condition beyond the forms merge-group-workflows.test.ts allows. */
function stepProblems(path: string, w: Workflow): string[] {
  const problems: string[] = [];
  for (const [key, job] of Object.entries(w.jobs))
    for (const step of job.steps ?? []) {
      const label = step.name ?? step.run ?? step.uses ?? '';
      const cond = condition(step.if);
      const ok =
        label === ONLY_ON_PUSH
          ? cond === "github.event_name == 'push'"
          : cond === undefined || cond === NOT_ON_PUSH;
      if (!ok) problems.push(`${path}: ${key}: ${label}: if: ${String(cond)}`);
    }
  return problems;
}

/**
 * Every way the workflows break the light pull request rule: a required check broken as above;
 * shards that skip anything but pull requests; an aggregate that does not always run over them; a
 * step condition; a queue-only entry naming a check that runs in full; or a full check wrapped in
 * the scope script. Empty when sound.
 */
export function workflowProblems(ci: Workflow, review: Workflow, queueOnly: string[]): string[] {
  const problems = [
    ...requiredProblems([ci, review]),
    ...stepProblems(CI, ci),
    ...stepProblems(REVIEW, review),
  ];
  const shards = condition(ci.jobs['database-shard']?.if);
  if (shards !== SKIPS_PULL_REQUESTS) problems.push(`database-shard: if: ${String(shards)}`);
  const aggregate = ci.jobs['database'];
  if (condition(aggregate?.if) !== 'always()' || String(aggregate?.needs) !== 'database-shard')
    problems.push('database: must always run over database-shard');
  for (const entry of queueOnly)
    if (!DEFERRED.has(entry)) problems.push(`queueOnly: ${entry} runs in full`);
  for (const job of Object.values(ci.jobs))
    if (FULL_ON_PR.has(job.name ?? '') && JSON.stringify(job.steps).includes('ci-scope'))
      problems.push(`${String(job.name)}: scoped, but it runs in full`);
  return problems;
}

/** The aggregate's script, run under GitHub's bash with each event and shards result. */
function aggregateProblems(step: Step | undefined): string[] {
  if (step?.run === undefined) return ['the aggregate has no script'];
  const problems = step.run.includes('${{') ? ['the script interpolates an expression'] : [];
  for (const event of ['merge_group', 'push', 'pull_request', '', 'workflow_dispatch'])
    for (const shards of ['success', 'skipped', 'failure', 'cancelled']) {
      const env: Env = { PATH: process.env['PATH'] ?? '' };
      for (const [key, value] of Object.entries(step.env ?? {})) {
        const expr = condition(value);
        if (expr === 'needs.database-shard.result') env[key] = shards;
        else if (expr === 'github.event_name') env[key] = event;
        else problems.push(`env ${key}: ${String(value)} is not read here`);
      }
      const out = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
        env,
        encoding: 'utf8',
      });
      const wants = shards === 'success' || (shards === 'skipped' && event === 'pull_request');
      const got = out.status === 0 ? 'passed' : 'failed';
      if ((out.status === 0) !== wants) problems.push(`${event || 'no event'} ${shards}: ${got}`);
    }
  return problems;
}

describe('the workflows: every required check reports on a pull request and on a group', () => {
  it('holds every rule, and the shards skip pull requests alone', () => {
    expect(problemsNow(load(CI))).toStrictEqual([]);
  });

  it('local checks runs pnpm check under its scope name, and defers every later step on a pull request', () => {
    const steps = load(CI).jobs['check']?.steps ?? [];
    const at = steps.findIndex((s) => s.run === 'pnpm check');
    expect(at).toBeGreaterThan(-1);
    expect(steps[at]?.env).toMatchObject({ CHECK_SCOPE: 'local checks' });
    const later = steps.slice(at + 1);
    expect(later.length).toBe(6);
    const deferred =
      /^node scripts\/ci-scope\.ts 'local checks' -- |\$\(node scripts\/ci-scope\.ts 'local checks' --decide\)/u;
    for (const s of later) expect(s.run, s.name).toMatch(deferred);
  });

  it('isolation tests runs each suite through its scope name', () => {
    const steps = load(CI).jobs['isolation']?.steps ?? [];
    const runs = steps.filter((s) => s.run !== undefined && !s.run.startsWith('pnpm install'));
    expect(runs.length).toBe(2);
    for (const s of runs)
      expect(s.run).toMatch(/^node scripts\/ci-scope\.ts 'isolation tests' -- /u);
  });

  it('the aggregate needs success on a group and a push, passes a skip on a pull request alone, and fails a failure or a cancel', () => {
    expect(aggregateProblems(aggregateStep(load(CI)))).toStrictEqual([]);
  }, 60_000);
});

describe('planted: each goes red', () => {
  it('a queue-only entry naming a check that runs in full on a pull request', () => {
    expect(
      workflowProblems(load(CI), load(REVIEW), [...queueOnlyOf(), 'contamination gate']),
    ).toContain('queueOnly: contamination gate runs in full');
  });

  it('a step condition on a required job’s step', () => {
    const ci = load(CI);
    const steps = ci.jobs['check']?.steps ?? [];
    const at = steps.findIndex((s) => s.run === 'pnpm check');
    steps[at] = { ...steps[at], if: "${{ github.event_name != 'pull_request' }}" };
    expect(problemsNow(ci)).toContain(`${CI}: check: pnpm check: if: ${SKIPS_PULL_REQUESTS}`);
  });

  it('shards skipped on a merge group', () => {
    const ci = load(CI);
    const shard = ci.jobs['database-shard'];
    if (shard !== undefined) shard.if = "github.event_name == 'pull_request'";
    expect(problemsNow(ci)).toContain("database-shard: if: github.event_name == 'pull_request'");
  });

  it('a required check skipped on a pull request', () => {
    const ci = load(CI);
    const local = ci.jobs['check'];
    if (local !== undefined) local.if = SKIPS_PULL_REQUESTS;
    expect(problemsNow(ci)).toContain(`local checks: if: ${SKIPS_PULL_REQUESTS}`);
  });

  it('the aggregate accepting a skip on a merge group, or refusing one on a pull request', () => {
    const step = aggregateStep(load(CI));
    const run = 'test "$SHARDS" = success || test "$SHARDS" = skipped';
    expect(aggregateProblems({ ...step, run })).toContain('merge_group skipped: passed');
    expect(aggregateProblems({ ...step, run: 'test "$SHARDS" = success' })).toContain(
      'pull_request skipped: failed',
    );
  }, 60_000);
});
