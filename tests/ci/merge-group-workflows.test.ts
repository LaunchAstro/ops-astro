// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-QUEUE: the workflows hold on a merge group the claim each required check holds on a pull
// request, and run nothing a group could pass by skipping. scripts/merge-group.mjs's own cases are
// tests/ci/merge-group.test.ts.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, ENV, group, read, repo, ROOT, type Repo } from './merge-group-repo.ts';
import { script, step, top } from './workflow-text.ts';

afterAll(cleanup);

const CI = '.github/workflows/ci.yml';
const REVIEW = '.github/workflows/review-evidence.yml';
const BINDS = 'The review must cover the head being merged';
const CODEQL = read('.github/workflows/codeql.yml');
const list = JSON.parse(read('.github/required-checks.json')) as {
  required_status_checks: { context: string; integration_id: number }[];
  code_scanning: { tool: string; alerts_threshold: string; security_alerts_threshold: string }[];
};
const required = list.required_status_checks;
const scanning = list.code_scanning;
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
      const cond = /^ {4}["']?if["']?: (.+)$/mu.exec(block)?.[1];
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

/** A step's key, as its first line or under it, quoted or not. */
const KEY = (key: string) => new RegExp(`^ {6}(?:- | {2})["']?${key}["']?: (.+)$`, 'mu');

describe('merge group: no step skips a group', () => {
  // review1 B1, review2 B2: a step-level condition, wherever it sits in the step and however its
  // key is quoted, could pass a group green without judging it, and so could `continue-on-error`.
  // Every step of every job in both workflows (the shards behind `database conformance` included)
  // runs on a group, apart from the one step that reads main from its root on a push.
  it('no step in either workflow is skipped on a group', () => {
    const ONLY_ON_PUSH = 'Public content and metadata from the root';
    for (const path of [CI, REVIEW])
      for (const s of top(read(path), 'jobs')
        .split(/^(?= {6}- )/mu)
        .slice(1)) {
        const name = KEY('(?:name|uses|run)').exec(s)?.[1] ?? s.slice(0, 80);
        const cond = KEY('if').exec(s)?.[1];
        const allowed =
          name === ONLY_ON_PUSH
            ? cond === "github.event_name == 'push'"
            : cond === undefined || cond === "github.event_name != 'push'";
        expect(allowed, `${path}: ${name}: if: ${cond}`).toBe(true);
      }
    expect(KEY('if').exec(top(read(REVIEW), 'jobs'))).toBeNull();
  });

  // CI-SPEED (ORCH78 LOOKAHEAD): one job may skip a group, the Postgres 18 look-ahead, which is
  // not required and runs on pull requests alone. Every other job runs on a group.
  it('no job in either workflow skips a group, apart from the not-required look-ahead', () => {
    const LOOKAHEAD = 'database look-ahead, Postgres 18 (not required)';
    expect(required.map((c) => c.context)).not.toContain(LOOKAHEAD);
    for (const path of [CI, REVIEW])
      for (const block of jobs(read(path))) {
        const name = /^ {4}name: (.+)$/mu.exec(block)?.[1] ?? block.slice(0, 80);
        const cond = /^ {4}["']?if["']?: (.+)$/mu.exec(block)?.[1];
        const allowed =
          name === LOOKAHEAD
            ? cond === "github.event_name == 'pull_request'"
            : [undefined, 'always()', "github.event_name != 'push'"].includes(cond);
        expect(allowed, `${path}: ${name}: if: ${cond}`).toBe(true);
      }
  });

  it('no job or step in either workflow lets a failure through', () => {
    for (const path of [CI, REVIEW])
      expect(top(read(path), 'jobs'), path).not.toMatch(/continue-on-error/u);
  });

  // review3 M7: the cases above read block style, two-space steps and plain or quoted keys. A
  // form they cannot read (flow style, a wider step indent, an escaped key) fails here instead.
  it('both workflows keep to the one form these cases read', () => {
    for (const path of [CI, REVIEW]) {
      const text = top(read(path), 'jobs');
      expect(text, `${path}: flow-style step`).not.toMatch(/^\s*- \{/mu);
      expect(text, `${path}: wider step indent`).not.toMatch(/^\s*- {2,}\S/mu);
      expect(text, `${path}: escaped key`).not.toMatch(/^\s*(?:- )?["'][^"'\n]*\\/mu);
    }
  });
});

/** A ci.yml step's one-line command, run on a group of #11 and #12 where each adds `file`. */
function sweep(name: string, file: string, text: string) {
  const r = repo();
  // Copied, not linked: both scanners read the repository they sit in.
  cpSync(join(ROOT, 'scripts'), join(r.dir, 'scripts'), { recursive: true });
  // In both pull requests (review3 M8): a scan of one of them alone does not pass.
  for (const pr of ['pr11', 'pr12']) {
    r.git('checkout', '-q', pr);
    writeFileSync(join(r.dir, `${pr}-${file}`), text);
    r.git('add', `${pr}-${file}`);
    r.git('commit', '-q', '-m', `feat: ${pr}, planted`);
  }
  r.git('checkout', '-q', '-B', 'queue', r.main);
  r.merge('pr11', 'Merge pull request #11 from LaunchAstro/pr11');
  const head = r.merge('pr12', 'Merge pull request #12 from LaunchAstro/pr12');
  const run = /^ {8}run: (.+)$/mu.exec(step(read(CI), name))?.[1] ?? '';
  return spawnSync('bash', ['-euo', 'pipefail', '-c', run], {
    cwd: r.dir,
    env: {
      ...ENV,
      GITHUB_EVENT_NAME: 'merge_group',
      GITHUB_EVENT_PATH: group(r.dir, head, `12-${r.main}`),
    },
    encoding: 'utf8',
  });
}

// review2 M5: the two range scans are run, not only read, so an early exit on a group shows.
describe('merge group: the range scans judge every pull request in the group', () => {
  for (const [name, file, bad] of [
    ['Sweep every blob in the incoming commits', 'leak.pem', 'planted\n'],
    [
      'Public content and metadata in every incoming commit',
      'notes.md',
      `see ${['', 'Users', 'someone', 'x'].join('/')}\n`,
    ],
  ] as const) {
    it(`${name}: passes a clean group`, () => {
      const out = sweep(name, 'fine.md', 'nothing here\n');
      expect(`${out.status} ${out.stdout} ${out.stderr}`).toMatch(/^0 /u);
    });

    it(`${name}: fails a group when each pull request's range holds what it refuses, naming both`, () => {
      const out = sweep(name, file, bad);
      expect(out.status).toBe(1);
      expect(out.stderr).toMatch(/failed for #11, #12\./u);
    });
  }
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

  // GitHub never posts the CodeQL results check on a merge group, so a required CodeQL check
  // would hold every group. The ruleset's code scanning rule gates on CodeQL's results instead.
  it('reports no Actions check named CodeQL, and CodeQL gates as a code scanning rule, not a required check', () => {
    expect(CODEQL).not.toMatch(/^ {4}name: CodeQL$/mu);
    expect(required.find((c) => c.context === 'CodeQL')).toBeUndefined();
    expect(scanning).toContainEqual({
      tool: 'CodeQL',
      alerts_threshold: 'errors',
      security_alerts_threshold: 'high_or_higher',
    });
  });

  it('only the analysis may write, and only its results', () => {
    expect(top(CODEQL, 'permissions')).toBe('permissions:\n  contents: read\n\n');
    expect(CODEQL.match(/^ +[\w-]+: write$/gmu)).toEqual(['      security-events: write']);
    expect(CODEQL).not.toMatch(/secrets\.|pull_request_target/u);
  });
});
