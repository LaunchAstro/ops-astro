// SPDX-License-Identifier: AGPL-3.0-only
//
// The merge queue waits only on the required checks, so a job no required check names takes
// runners from a group and protects nothing there (cut 6, 13 October 2026). CodeQL, visual drift
// and the Postgres 18 look-ahead stay out of merge groups: CodeQL scans each pull request and main
// on every push and each night, visual drift runs on a pull request and a push and each night on
// main, and the look-ahead stays nightly. That every required check still runs on a group is
// tests/ci/merge-group-workflows.test.ts.

import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { read } from './merge-group-repo.ts';

type Job = Record<string, unknown>;
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

const parse = (path: string): Workflow => {
  const doc = parseDocument(read(path), { merge: true, uniqueKeys: true });
  expect(doc.errors, path).toStrictEqual([]);
  return doc.toJS() as Workflow;
};

const CI = parse('.github/workflows/ci.yml');
const CODEQL = parse('.github/workflows/codeql.yml');
const LOOKAHEAD = parse('.github/workflows/lookahead.yml');
const NIGHTLY = parse('.github/workflows/visual-drift-nightly.yml');
const required = (
  JSON.parse(read('.github/required-checks.json')) as {
    required_status_checks: { context: string }[];
  }
).required_status_checks.map((c) => c.context);

/** A cron line that fires once every day: fixed minute and hour, every day of every month. */
const DAILY = /^\d{1,2} \d{1,2} \* \* \*$/u;
const crons = (w: Workflow) =>
  ((w.on['schedule'] ?? []) as { cron: string }[]).map((entry) => entry.cron);

describe('non-required jobs stay out of merge groups', () => {
  it('no required check names CodeQL, visual drift or the look-ahead', () => {
    const names = [
      ...Object.values(CODEQL.jobs),
      CI.jobs['visual-drift'],
      ...Object.values(NIGHTLY.jobs),
      ...Object.values(LOOKAHEAD.jobs),
    ].map((job) => String(job?.['name']));
    expect(names.length).toBeGreaterThan(3);
    for (const name of names) expect(required, name).not.toContain(name);
    expect(required.filter((context) => /^Analyze|^CodeQL$/u.test(context))).toStrictEqual([]);
  });

  it('CodeQL scans a pull request, a push to main and main each night, and no merge group', () => {
    expect(Object.keys(CODEQL.on).toSorted()).toStrictEqual(['pull_request', 'push', 'schedule']);
    expect(CODEQL.on['push']).toStrictEqual({ branches: ['main'] });
    expect(crons(CODEQL)).toHaveLength(1);
    expect(crons(CODEQL)[0]).toMatch(DAILY);
  });

  it('visual drift skips a merge group in ci.yml and nothing else', () => {
    const job = CI.jobs['visual-drift'];
    expect(job?.['if']).toBe("github.event_name != 'merge_group'");
    expect(Object.keys(CI.on)).toEqual(expect.arrayContaining(['pull_request', 'push']));
  });

  it('visual drift runs each night on main with ci.yml’s own steps', () => {
    expect(Object.keys(NIGHTLY.on).toSorted()).toStrictEqual(['schedule', 'workflow_dispatch']);
    expect(crons(NIGHTLY)).toHaveLength(1);
    expect(crons(NIGHTLY)[0]).toMatch(DAILY);
    const ci = CI.jobs['visual-drift'];
    const nightly = NIGHTLY.jobs['visual-drift'];
    expect(nightly?.['steps']).toStrictEqual(ci?.['steps']);
    expect(nightly?.['runs-on']).toBe(ci?.['runs-on']);
    expect(nightly?.['timeout-minutes']).toBe(ci?.['timeout-minutes']);
    expect(read('.github/workflows/visual-drift-nightly.yml')).not.toMatch(/: write$/mu);
  });

  it('the Postgres 18 look-ahead runs each night and on demand, and on no merge group', () => {
    expect(Object.keys(LOOKAHEAD.on).toSorted()).toStrictEqual(['schedule', 'workflow_dispatch']);
    expect(crons(LOOKAHEAD)[0]).toMatch(DAILY);
  });
});
