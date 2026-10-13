// SPDX-License-Identifier: AGPL-3.0-only
//
// Clearing the review-debt labels from merged pull requests started ci.yml's seventeen jobs and a
// review-evidence run that failed on each one, leaving a red mark on a pull request that had
// already merged (#1265, 12 October 2026). A label change on a closed or merged pull request now
// runs no job in a workflow that listens for one; an open pull request, a push and a merge group
// run exactly the jobs they ran before. Each job's run is worked out from its condition and what
// it waits on, as GitHub decides it: a job whose condition holds no status function skips when a
// job it needs did not run.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { read, ROOT } from './merge-group-repo.ts';
import { OPEN_GUARD, unguarded } from './open-pull-request.ts';
import { FULL_GUARD } from './full-checks.ts';

type Job = { if?: unknown; needs?: unknown };
type Workflow = { on?: Record<string, { types?: string[] } | null>; jobs: Record<string, Job> };
type Ctx = { event: string; state?: 'open' | 'closed' };

const WORKFLOWS = '.github/workflows';
const VERDICT_GUARD =
  "github.event_name == 'merge_group' || github.event.pull_request.state == 'open'";
const load = (file: string): Workflow =>
  parseDocument(read(`${WORKFLOWS}/${file}`), { merge: true, uniqueKeys: true }).toJS({
    maxAliasCount: 100,
  }) as Workflow;
const condition = (value: unknown) =>
  typeof value === 'string' ? value.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/u, '$1') : value;
const needsOf = (job: Job): string[] =>
  job.needs === undefined ? [] : ([] as unknown[]).concat(job.needs).map(String);

/** Every workflow a label change on a pull request starts. */
const listeners = readdirSync(join(ROOT, WORKFLOWS))
  .filter((file) => file.endsWith('.yml'))
  .filter((file) =>
    (load(file).on?.['pull_request']?.types ?? []).some(
      (t) => t === 'labeled' || t === 'unlabeled',
    ),
  )
  .toSorted();

/** The guard's meaning: true on a push and a merge group, and on a pull request while it is open. */
const guardHolds = (ctx: Ctx) => ctx.event !== 'pull_request' || ctx.state === 'open';

/** Whether a job's own condition lets it start under `ctx`; `always` ignores what it waits on. */
function own(cond: unknown, ctx: Ctx, guarded: boolean): boolean | 'always' {
  if (cond === VERDICT_GUARD)
    return !guarded || ctx.event === 'merge_group' || ctx.state === 'open';
  const rest = unguarded(cond);
  if (guarded && rest !== cond && !guardHolds(ctx)) return false;
  if (rest === undefined) return true;
  if (rest === 'always()') return 'always';
  // `full checks` waits on the gate, which decides; a closed pull request's gate never runs.
  if (rest === FULL_GUARD) return true;
  const match = /^github\.event_name (==|!=) '(\w+)'$/u.exec(String(rest));
  if (match === null) throw new Error(`a condition this test does not read: ${String(rest)}`);
  return (match[1] === '==') === (ctx.event === match[2]);
}

/** The jobs that run under `ctx`, with the guard read as written or, unguarded, as if absent. */
function ran(workflow: Workflow, ctx: Ctx, guarded = true): string[] {
  const memo = new Map<string, boolean>();
  const runs = (key: string): boolean => {
    const known = memo.get(key);
    if (known !== undefined) return known;
    const job = workflow.jobs[key];
    if (job === undefined) throw new Error(`a job waits on ${key}, which is not there`);
    const start = own(condition(job.if), ctx, guarded);
    const result = start === 'always' || (start && needsOf(job).every((need) => runs(need)));
    memo.set(key, result);
    return result;
  };
  return Object.keys(workflow.jobs).filter((key) => runs(key));
}

const CLOSED: Ctx = { event: 'pull_request', state: 'closed' };
const RUNNING: [string, Ctx][] = [
  ['an open pull request', { event: 'pull_request', state: 'open' }],
  ['a push', { event: 'push' }],
  ['a merge group', { event: 'merge_group' }],
];

describe('a label change on a closed or merged pull request runs nothing', () => {
  it('the CI, review evidence and verdict workflows start on a label change', () => {
    expect(listeners).toStrictEqual(['ci.yml', 'review-evidence.yml', 'sol-verdict.yml']);
  });

  it.each(listeners)('%s runs no job on a closed or merged pull request', (file) => {
    expect(ran(load(file), CLOSED)).toStrictEqual([]);
  });

  // Each event the workflow starts on; review-evidence.yml has no push.
  const cases = listeners.flatMap((file) =>
    RUNNING.filter(([, ctx]) => ctx.event in (load(file).on ?? {})).map(
      ([label, ctx]) => [file, label, ctx] as const,
    ),
  );

  it.each(cases)('%s runs on %s exactly the jobs it ran without the guard', (file, _label, ctx) => {
    const workflow = load(file);
    const jobs = ran(workflow, ctx);
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs).toStrictEqual(ran(workflow, ctx, false));
  });
});

describe('planted: a guard that is not the exact one is not read as the guard', () => {
  it.each([
    "github.event_name != 'pull_request' || github.event.pull_request.state != 'closed'",
    `always() && ${OPEN_GUARD}`,
    `${OPEN_GUARD} || true`,
    `(${OPEN_GUARD})`,
  ])('%s', (mangled) => {
    expect(unguarded(mangled)).toBe(mangled);
    const ci = load('ci.yml');
    ci.jobs['gate'] = { ...ci.jobs['gate'], if: mangled };
    expect(() => ran(ci, CLOSED)).toThrow(/a condition this test does not read/u);
  });
});
