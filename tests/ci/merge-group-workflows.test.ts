// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-QUEUE: the workflows hold on a merge group the claim each required check holds on a pull
// request, and run nothing a group could pass by skipping. scripts/merge-group.mjs's own cases are
// tests/ci/merge-group.test.ts.

import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, ENV, group, read, repo, ROOT, type Repo } from './merge-group-repo.ts';
import { script, step, top } from './workflow-text.ts';

afterAll(cleanup);

const CI = '.github/workflows/ci.yml';
const REVIEW = '.github/workflows/review-evidence.yml';
const BINDS = 'The review must cover the head being merged';
const CODEQL = read('.github/workflows/codeql.yml');
const required = (
  JSON.parse(read('.github/required-checks.json')) as {
    required_status_checks: { context: string; integration_id: number }[];
  }
).required_status_checks;
const jobs = (text: string) =>
  top(text, 'jobs')
    .split(/^(?= {2}[\w-]+:$)/mu)
    .slice(1);

/** A body that passes review evidence for `head`. */
const body = (head: string) =>
  `Reviewer: Sol (Codex)\nModel: gpt-6-sol\nHead SHA: ${head}\nVerdict: approve\n\n` +
  `Review checkpoint\n  branch:      work\n  base:        main\n  head:        ${head}\n  commits:     1\n\n` +
  'Code review: no findings\n\nSecurity review: not required: no sensitive paths changed\n';

/** The review-evidence step, run on a group of #11 and #12 whose bodies name `heads`. */
function judge(heads: (r: Repo) => [string, string]) {
  const r = repo();
  symlinkSync(join(ROOT, 'scripts'), join(r.dir, 'scripts'));
  const temp = join(r.dir, '.runner');
  const [b11, b12] = heads(r);
  for (const [n, head, b] of [
    [11, r.pr11, b11],
    [12, r.pr12, b12],
  ] as const) {
    mkdirSync(join(temp, `pr-${n}`), { recursive: true });
    const json = {
      number: n,
      state: 'open',
      head: { sha: head },
      base: { ref: 'main' },
      body: body(b),
      labels: [],
    };
    writeFileSync(join(temp, `pr-${n}`, 'pull.json'), JSON.stringify(json));
  }
  writeFileSync(join(temp, 'open-issues.txt'), '');
  const event = group(r.dir, r.g12, `12-${r.main}`);
  return spawnSync('bash', ['-euo', 'pipefail', '-c', script(step(read(REVIEW), BINDS))], {
    cwd: r.dir,
    env: {
      ...ENV,
      GITHUB_EVENT_NAME: 'merge_group',
      GITHUB_EVENT_PATH: event,
      RUNNER_TEMP: temp,
    },
    encoding: 'utf8',
  });
}

// The claim on a pull request, held on a group: review evidence reads each pull request's own
// body and binds it to that pull request's head (docs/agents/review-checkpoint.md).
describe('merge group: review evidence for every pull request in the group', () => {
  it('passes when every pull request carries evidence for its own head', () => {
    const out = judge((r) => [r.pr11, r.pr12]);
    expect(`${out.status} ${out.stderr}`).toMatch(/^0 /u);
  });

  it('fails when one pull request carries evidence for another head', () => {
    const out = judge((r) => [r.pr11, r.pr11]);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/#12/u);
  });
});

describe('merge group: every required check runs on a group, and none passes it by skipping', () => {
  it('both workflows run on merge_group', () => {
    for (const path of [CI, REVIEW])
      expect(top(read(path), 'on'), path).toMatch(/^ {2}merge_group:$/mu);
  });

  it('every required Actions check is a job of a workflow that runs on merge_group, with no condition that skips a group', () => {
    const all = [CI, REVIEW].flatMap((p) => jobs(read(p)));
    const actions = required.filter((c) => c.integration_id === 15368).map((c) => c.context);
    for (const name of actions) {
      const block = all.find((b) => /^ {4}name: (.+)$/mu.exec(b)?.[1] === name) ?? '';
      expect(block, name).not.toBe('');
      const cond = /^ {4}if: (.+)$/mu.exec(block)?.[1];
      // A push to main has no pull request; anything narrower could skip a group.
      const runs = [undefined, 'always()', "github.event_name != 'push'"].includes(cond);
      expect(runs, `${name}: if: ${cond}`).toBe(true);
    }
  });

  it('every step that reads the pull request range runs once per pull request, on a pull request and on a group', () => {
    const ci = read(CI);
    const ranged = ci.split(/^(?= {6}- )/mu).filter((s) => /BASE_SHA|base\.sha/u.test(s));
    expect(ranged.length).toBeGreaterThan(0);
    for (const s of ranged) {
      const name = /name: (.+)/u.exec(s)?.[1] ?? s.slice(0, 80);
      expect(s, name).not.toContain('github.event.pull_request.');
      expect(s, name).toMatch(/node scripts\/merge-group\.mjs each|merge-group\.mjs/u);
      expect(/^ {8}if: (.+)$/mu.exec(s)?.[1] ?? '', name).not.toMatch(/== 'pull_request'$/u);
    }
  });
});

// ORCH55-CQL: CodeQL's default setup never runs on a group, so advanced setup takes its place.
describe('merge group: CodeQL reports on a group', () => {
  it('runs on a pull request, a push to main, a group and a weekly schedule, for the languages default setup scanned', () => {
    expect(top(CODEQL, 'on')).toMatch(
      /^ {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n {2}merge_group:\n {2}schedule:\n/mu,
    );
    expect(CODEQL).toContain('language: [actions, javascript-typescript, python]');
    expect(CODEQL).toContain("category: '/language:${{ matrix.language }}'");
  });

  it('reports no Actions check named CodeQL: that name is the code scanning results check, integration 57789', () => {
    expect(CODEQL).not.toMatch(/^ {4}name: CodeQL$/mu);
    const codeql = required.find((c) => c.context === 'CodeQL');
    expect(codeql?.integration_id).toBe(57789);
  });

  it('only the analysis may write, and only its results', () => {
    expect(top(CODEQL, 'permissions')).toBe('permissions:\n  contents: read\n\n');
    expect(CODEQL.match(/^ +[\w-]+: write$/gmu)).toEqual(['      security-events: write']);
    expect(CODEQL).not.toMatch(/secrets\.|pull_request_target/u);
  });
});
