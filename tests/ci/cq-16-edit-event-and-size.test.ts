// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-16: a description edit re-runs only `review evidence for this revision`, and the size report
// counts non-test code only. Each case is named after a line of the ticket's supporting checklist.
// Since FU-400 (owner, 29 September 2026) the size is reported, not limited: every case exits 0,
// and the counting is proven by the report instead.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const CI = '.github/workflows/ci.yml';
// FU-93 moved the check here from ci.yml; it runs on code events and on an edit.
const REVIEW = '.github/workflows/review-evidence.yml';
const CHECK = 'review evidence for this revision';

/** A top-level key's block, from `key:` to the next line that starts in column one. */
function top(text: string, key: string): string {
  return new RegExp(`^${key}:.*\\n(?:(?: .*)?\\n)*`, 'mu').exec(text)?.[0] ?? '';
}

/** Every job under `jobs:`, keyed by its id. */
function jobs(text: string): Map<string, string> {
  const parts = top(text, 'jobs')
    .split(/^(?= {2}[\w-]+:$)/mu)
    .slice(1);
  return new Map(parts.map((block) => [block.trim().split(':')[0] ?? '', block]));
}

/** The job whose check name is `name`. */
function job(text: string, name: string): string {
  return [...jobs(text).values()].find((b) => b.includes(`\n    name: ${name}\n`)) ?? '';
}

/** One step of a job, from its `- name:` line to the next step. */
function step(block: string, name: string): string {
  const start = block.indexOf(`      - name: ${name}\n`);
  if (start === -1) return '';
  const next = block.slice(start + 1).search(/^ {6}- /mu);
  return block.slice(start, next === -1 ? undefined : start + 1 + next);
}

/** A step's `run: |` script, unindented. */
function script(block: string): string {
  const lines = block.split('\n');
  const at = lines.findIndex((l) => /^ {8}run: \|$/u.test(l));
  const body = lines.slice(at + 1).filter((l) => l === '' || l.startsWith('          '));
  return at === -1 ? '' : body.map((l) => l.slice(10)).join('\n');
}

const FETCH = 'Read the description as it stands now';
const CASES = "The checker's own cases";
const BINDS = 'The review must cover the head being merged';
const BASE = 'A base change needs every check run again';

describe('CQ-16 edited runs review evidence only', () => {
  it('CQ-16 edited runs review evidence only: ci.yml no longer runs on edited, the new workflow runs on edited alone', () => {
    const ci = read(CI);
    const types = /^ {4}types: \[(.*)\]$/mu.exec(top(ci, 'on'))?.[1]?.split(/,\s*/u);
    expect(types).toEqual(['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled']);

    expect(prTypes(read(REVIEW))).toContain('edited');
  });

  it('CQ-16 edited runs review evidence only: one job, with no condition, named exactly as the required check', () => {
    const edit = jobs(read(REVIEW));
    expect([...edit.keys()]).toEqual(['review-evidence']);
    const block = edit.get('review-evidence') ?? '';
    expect(/^ {4}name: (.*)$/mu.exec(block)?.[1]).toBe(CHECK);
    expect(job(read(CI), CHECK)).toBe('');
    // A condition could skip it, and `needs` would name a job this workflow does not hold.
    expect(block.match(/^ {4}(if|needs):/mu)).toBeNull();
  });

  it('CQ-16 edited runs review evidence only: an edit cannot cancel a code run, because its concurrency group is its own', () => {
    const edit = read(REVIEW);
    expect(/^name: (.*)$/mu.exec(edit)?.[1]).not.toBe(/^name: (.*)$/mu.exec(read(CI))?.[1]);
    expect(top(edit, 'concurrency')).toContain('group: ${{ github.workflow }}-${{ github.ref }}');
  });

  it('CQ-16 edited runs review evidence only: both runs read the description as it stands, and judge it last', () => {
    const block = job(read(REVIEW), CHECK);
    // The event's copy of the body is the body when the run was queued. A code run that
    // finishes after an edit's run must not judge the old one.
    expect(block).not.toContain('github.event.pull_request.body');
    expect(step(block, FETCH)).toContain('gh api "repos/${REPO}/pulls/${PR_NUMBER}"');
    expect(step(block, BINDS)).toContain('PR_BODY="$(cat "${RUNNER_TEMP}/pr-body.md")"');
    expect(step(block, BINDS)).toContain('node scripts/review-evidence-check.mjs');
    expect(step(block, CASES)).toContain('bash tests/ci/review-evidence-cases.sh');
    const order = [CASES, FETCH, BINDS].map((n) => block.indexOf(`- name: ${n}\n`));
    expect(order.every((at, i) => at > (order[i - 1] ?? -1))).toBe(true);
  });

  it('CQ-16 edited runs review evidence only: a base change fails the edit run until every check runs again', () => {
    const block = job(read(REVIEW), CHECK);
    const base = step(block, BASE);
    expect(base).toContain('BASE_FROM: ${{ github.event.changes.base.ref.from }}');
    expect(block.indexOf(`- name: ${BASE}\n`)).toBeLessThan(block.indexOf(`- name: ${FETCH}\n`));
    const run = (from: string) =>
      spawnSync('bash', ['-euo', 'pipefail', '-c', script(base)], {
        env: { ...process.env, BASE_FROM: from },
        encoding: 'utf8',
      });
    const moved = run('cq-15/security-gate');
    expect(`${moved.status} ${moved.stdout}`).toMatch(/^1 ::error::.*close and reopen/u);
    expect(run('').status).toBe(0);
  });
});

describe('CQ-16 workflow permissions', () => {
  it('CQ-16 workflow permissions: the new workflow holds a read-only token and no secret', () => {
    const edit = read(REVIEW);
    expect(top(edit, 'permissions')).toBe(
      'permissions:\n  contents: read\n  pull-requests: read\n\n',
    );
    expect(
      edit.match(/secrets\.|GITHUB_TOKEN|write|pull_request_target|^ {4}permissions:/mu),
    ).toBeNull();
  });

  it('CQ-16 workflow permissions: no ci.yml job gains a secret or a write permission', () => {
    const ci = read(CI);
    expect(ci.match(/secrets\.|GITHUB_TOKEN|write|pull_request_target/u)).toBeNull();
    expect(top(ci, 'permissions')).toBe('permissions:\n  contents: read\n\n');
    const own = [...jobs(ci)].filter(([, b]) => /^ {4}permissions:/mu.test(b)).map(([k]) => k);
    expect(own).toEqual([]);
  });

  it('CQ-16 workflow permissions: the token reaches only the step that reads the description', () => {
    const block = job(read(REVIEW), CHECK);
    expect(block.match(/github\.token/gu)).toHaveLength(1);
    expect(step(block, FETCH)).toContain('GH_TOKEN: ${{ github.token }}');
    // The checkout leaves no copy of the token in .git/config for the steps that run head code.
    expect(block).toContain('persist-credentials: false');
  });
});

const SIZER = join(ROOT, 'scripts/pr-size.mjs');
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const numbered = (count: number, word = 'line') =>
  Array.from({ length: count }, (_, i) => `${word} ${String(i + 1)}\n`).join('');

/** A throwaway repository: a seed commit, then one commit holding every file given. */
function sized(
  files: Record<string, number>,
  labels = '',
  setup?: (dir: string) => void,
  change?: (dir: string) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), 'cq16-'));
  made.push(dir);
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).stdout.trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Size Test');
  git('config', 'user.email', 'size-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  setup?.(dir);
  git('add', '-A');
  git('commit', '-qm', 'seed');
  const base = git('rev-parse', 'HEAD');
  change?.(dir);
  for (const [path, count] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), numbered(count));
  }
  git('add', '-A');
  git('commit', '-qm', 'change');
  const env = {
    ...process.env,
    BASE_SHA: base,
    HEAD_SHA: git('rev-parse', 'HEAD'),
    PR_LABELS: labels,
  };
  const done = spawnSync('node', [SIZER], { cwd: dir, env, encoding: 'utf8' });
  return { status: done.status, out: done.stdout + done.stderr };
}

describe('CQ-16 size counts code only', () => {
  it('CQ-16 size counts code only: 300 code and 300 test lines pass, and the report lists both', () => {
    const { status, out } = sized({ 'src/a.ts': 300, 'tests/a.test.ts': 300 });
    expect(status).toBe(0);
    expect(out).toContain('pr-size: 300 changed lines of non-test code across 1 file(s).');
    expect(out).toContain('pr-size: 300 changed test lines across 1 file(s), not counted.');
    expect(out).toContain('pr-size:   tests/a.test.ts (300, test)');
  });

  it('CQ-16 size counts code only: 401 code lines pass and are reported', () => {
    const { status, out } = sized({ 'src/a.ts': 201, 'src/b.ts': 200, 'tests/b.test.ts': 50 });
    expect(status).toBe(0);
    expect(out).toContain('pr-size: 401 changed lines of non-test code across 2 file(s).');
    expect(out).toContain('pr-size: the size is reported, not limited; this check never blocks.');
    expect(out).not.toContain('::error::');
  });

  it('CQ-16 size counts code only: a test file over 400 lines is not counted', () => {
    const big = sized({ 'tests/big.test.ts': 600 });
    expect(big.status).toBe(0);
    expect(big.out).toContain('pr-size: 0 changed lines of non-test code across 0 file(s).');
    expect(sized({ 'tests/db/named-suites.json': 500, 'src/a.ts': 10 }).status).toBe(0);
    expect(sized({ 'packages/x/src/big.test.ts': 450, 'apps/web/big.spec.tsx': 450 }).status).toBe(
      0,
    );
  });

  it('CQ-16 size counts code only: fixtures and scripts outside tests/ count', () => {
    for (const path of [
      'packages/x/fixtures/a.json',
      'scripts/tests-helper.mjs',
      'packages/x/tests/a.ts',
      'src/test.ts',
    ]) {
      const { status, out } = sized({ [path]: 401 });
      expect(status).toBe(0);
      expect(out).toContain('pr-size: 401 changed lines of non-test code across 1 file(s).');
    }
  });

  it('CQ-16 size counts code only: a file moved between code and tests counts unless both sides are tests', () => {
    // 600 lines, then moved with 250 of them rewritten: git still reads it as a rename, 500 lines.
    const move = (from: string, to: string) =>
      sized(
        {},
        '',
        (dir) => {
          mkdirSync(dirname(join(dir, from)), { recursive: true });
          writeFileSync(join(dir, from), numbered(600, 'seed'));
        },
        (dir) => {
          rmSync(join(dir, from));
          mkdirSync(dirname(join(dir, to)), { recursive: true });
          writeFileSync(
            join(dir, to),
            numbered(250, 'new') +
              numbered(600, 'seed')
                .split(/(?<=\n)/u)
                .slice(250)
                .join(''),
          );
        },
      );
    const out = move('src/keep.ts', 'tests/keep.test.ts');
    expect(`${String(out.status)} ${out.out}`).toMatch(
      /^0 [\s\S]*src\/keep\.ts => tests\/keep\.test\.ts: 500 counted, 0 treated as moved \(500 changed\)/u,
    );
    const bothTests = move('tests/a.test.ts', 'tests/b.test.ts');
    expect(bothTests.status).toBe(0);
    expect(bothTests.out).toContain('pr-size: 0 changed lines of non-test code across 0 file(s).');
    const intoCode = move('tests/a.test.ts', 'src/a.ts');
    expect(intoCode.status).toBe(0);
    expect(intoCode.out).toContain('tests/a.test.ts => src/a.ts: 500 counted');
  });
});

describe('CQ-16 waivers retired', () => {
  it('CQ-16 waivers retired: a label changes neither the exit nor the report', () => {
    const over = { 'src/a.ts': 250, 'src/b.ts': 250, 'tests/a.test.ts': 300 };
    const bare = sized(over);
    expect(bare.status).toBe(0);
    for (const label of ['size-waiver-coherence', 'size-waiver-mechanical']) {
      const labelled = sized(over, label);
      expect(labelled.status).toBe(0);
      // The repositories differ only in their commit hashes, which the report does not print.
      expect(labelled.out).toBe(bare.out);
    }
  });

  it('CQ-16 waivers retired: a code file over 400 lines passes and is reported per file', () => {
    const { status, out } = sized({ 'src/huge.ts': 401 });
    expect(status).toBe(0);
    expect(out).toContain('pr-size:   src/huge.ts: 401 counted, 0 treated as moved (401 changed)');
  });

  it('CQ-16 waivers retired: a generated file still counts towards the total', () => {
    const { status, out } = sized({ 'src/a.ts': 300, 'pnpm-lock.yaml': 200 });
    expect(status).toBe(0);
    expect(out).toContain('pr-size: 500 changed lines of non-test code across 2 file(s).');
  });
});

describe('CQ-16 contributing says code only', () => {
  it("CQ-16 contributing says code only: CONTRIBUTING's size rule says the report counts product code only", () => {
    const rule = /^## Keep changes reviewable\n\n([\s\S]*?)\n\n/mu.exec(
      read('CONTRIBUTING.md'),
    )?.[1];
    const text = (rule ?? '').replace(/\s+/gu, ' ');
    expect(text).toContain('counts product code only');
    expect(text).toContain('Test files are listed in the report but never count');
    expect(text).toContain('`tests/`');
    expect(text).toContain('`*.test.*`');
    expect(text).toContain('`*.spec.*`');
    expect(text).toContain('reported, not limited');
    // Addendum 4 (owner, 29 September 2026): about 400 lines is a guide for a readable chunk, never a gate.
    expect(text).toContain('About 400 changed lines is a guide for a readable chunk');
    expect(text).toContain('never a gate');
    expect(text).toContain(
      'Nothing is split into separate sessions, lanes or review queues to meet a size',
    );
  });
});

// FU-93, issue 93: the edit run's passing result sat beside the push run's failed one, because
// the two came from different workflows, and the pull request stayed blocked until someone re-ran
// the push run's job. A newer run of a workflow replaces its older run's results, so one workflow
// must hold the check and run on every event that can change its verdict.
const workflows = () =>
  readdirSync(join(ROOT, '.github/workflows'))
    .filter((f) => /\.ya?ml$/u.test(f))
    .map((f) => `.github/workflows/${f}`);

/** The `pull_request` event types a workflow runs on; GitHub's default when it names none. */
function prTypes(text: string): string[] {
  const on = top(text, 'on');
  if (!/^ {2}pull_request:/mu.test(on)) return [];
  const listed = /^ {2}pull_request:\n {4}types: \[(.*)\]$/mu.exec(on)?.[1];
  return listed === undefined ? ['opened', 'synchronize', 'reopened'] : listed.split(/,\s*/u);
}

/** Every check name a workflow's jobs report under. */
const names = (text: string) => [...text.matchAll(/^ {4}name: (.+)$/gmu)].map((m) => m[1]?.trim());

describe('FU-93 one workflow owns review evidence', () => {
  it('FU-93 one workflow owns review evidence: one job in one workflow carries the check name, so a newer run replaces a stale failure', () => {
    expect(workflows().filter((p) => job(read(p), CHECK) !== '')).toEqual([REVIEW]);
  });

  it('FU-93 one workflow owns review evidence: it runs when the head is opened, moved or reopened, and on an edit', () => {
    expect(top(read(REVIEW), 'on')).toBe(
      'on:\n  pull_request:\n    types: [opened, synchronize, reopened, edited]\n\n',
    );
    expect(read(REVIEW)).not.toContain('pull_request_target');
  });

  it('FU-93 one workflow owns review evidence: a push runs every required check, and an edit runs this one alone', () => {
    const required = (
      JSON.parse(read('.github/required-checks.json')) as {
        required_status_checks: { context: string; integration_id: number }[];
      }
    ).required_status_checks
      .filter((c) => c.integration_id === 15368)
      .map((c) => c.context);
    const on = (event: string) =>
      workflows()
        .filter((p) => prTypes(read(p)).includes(event))
        .flatMap((p) => names(read(p)));
    for (const event of ['opened', 'synchronize', 'reopened'])
      for (const context of required) expect(on(event), `${event}: ${context}`).toContain(context);
    // Nothing else runs on an edit, so no other check is re-run, skipped, cancelled or left missing.
    expect(on('edited')).toEqual([CHECK]);
  });
});
