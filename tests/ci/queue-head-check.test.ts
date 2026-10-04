// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SPEED (#724): a pull request whose head is a merge-queue commit runs no checks, so its
// results never land beside the group's own. The script cases run the real script, with real
// git listing a real (local, bare) remote; the wiring case reads ci.yml with the YAML parser.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
// @ts-expect-error -- the check is a plain JavaScript module, as the gate runs it
import { pullHead, queueTips, refusal } from '../../scripts/queue-head-check.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts/queue-head-check.mjs');
const dir = mkdtempSync(join(tmpdir(), 'queue-head-check-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Git without the machine's own settings (signing, URL rewrites), so the remote is the one here.
const GIT_ENV = {
  PATH: process.env['PATH'],
  HOME: dir,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...GIT_ENV,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// The base repository: main, one queue branch, and a branch whose name only contains the queue's
// path further in, which `git ls-remote origin 'refs/heads/gh-readonly-queue/*'` still prints.
const remote = join(dir, 'remote.git');
git(dir, 'init', '-q', '--bare', remote);
const work = join(dir, 'work');
mkdirSync(work);
git(work, 'init', '-q', '-b', 'main');
git(work, 'remote', 'add', 'origin', remote);
const commit = (message: string): string => {
  git(work, 'commit', '-q', '--allow-empty', '-m', message);
  return git(work, 'rev-parse', 'HEAD');
};
const main = commit('docs: start');
const queued = commit('Merge pull request #1 from LaunchAstro/one');
const lookalike = commit('feat: not a queue branch');
const QUEUE_REF = `refs/heads/gh-readonly-queue/main/pr-1-${main}`;
const LOOKALIKE_REF = `refs/heads/x/refs/heads/gh-readonly-queue/main/pr-2-${main}`;
git(work, 'push', '-q', 'origin', `${main}:refs/heads/main`, `${queued}:${QUEUE_REF}`);
git(work, 'push', '-q', 'origin', `${lookalike}:${LOOKALIKE_REF}`);

// A checkout whose origin cannot be listed: nothing answers on port 9. Its URL carries a planted
// credential, and the marker in its path is what git prints when the listing fails.
const MARKER = 'PLANTED-TOKEN-MARKER';
const broken = join(dir, 'broken');
mkdirSync(broken);
git(broken, 'init', '-q', '-b', 'main');
git(broken, 'remote', 'add', 'origin', `http://planted-user:${MARKER}@127.0.0.1:9/${MARKER}.git`);

/** Runs the check as the gate does, in `cwd`, on `payload` written where GitHub writes the event. */
function check(eventName: string, payload?: unknown, cwd = work) {
  const env: NodeJS.ProcessEnv = { ...GIT_ENV, GITHUB_EVENT_NAME: eventName };
  if (payload !== undefined) {
    const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, typeof payload === 'string' ? payload : JSON.stringify(payload));
    env['GITHUB_EVENT_PATH'] = path;
  }
  const run = spawnSync(process.execPath, [SCRIPT], { cwd, env, encoding: 'utf8' });
  return { status: run.status, out: run.stdout + run.stderr };
}

const pr = (sha: unknown, ref: unknown = 'feature/one') => ({
  action: 'synchronize',
  pull_request: { number: 9, head: { sha, ref } },
});
const flip = (sha: string) => sha.slice(0, -1) + (sha.endsWith('0') ? '1' : '0');

describe('the queue-head check, run as the gate runs it', () => {
  it('fails a pull request whose head is a queue branch’s tip, whatever its branch is called', () => {
    const run = check('pull_request', pr(queued));
    expect(run.status).toBe(1);
    expect(run.out).toContain(queued);
    expect(run.out).toMatch(/merge-queue commit/u);
    expect(check('pull_request', pr(queued.toUpperCase())).status).toBe(1);
  });

  it('fails a pull request from a branch named like a queue branch', () => {
    const run = check('pull_request', pr(main, 'gh-readonly-queue/main/pr-1-abc'));
    expect(run.status).toBe(1);
    expect(run.out).toMatch(/gh-readonly-queue\//u);
  });

  it('passes an ordinary pull request, and one whose head only shares a prefix with a tip', () => {
    expect(check('pull_request', pr(main)).status).toBe(0);
    expect(check('pull_request', pr(flip(queued))).status).toBe(0);
  });

  it('does not count a branch whose name only contains the queue’s path further in', () => {
    const listed = git(work, 'ls-remote', 'origin', 'refs/heads/gh-readonly-queue/*');
    // Git prints it, so the parse is what refuses it.
    expect(listed).toContain(LOOKALIKE_REF);
    expect(check('pull_request', pr(lookalike)).status).toBe(0);
  });
});

describe('the queue-head check, on what it cannot read and on other events', () => {
  it('fails closed on a pull request when the queue branches cannot be listed', () => {
    const run = check('pull_request', pr(main), broken);
    expect(run.status).toBe(1);
    expect(run.out).toMatch(/could not list/u);
    // Git's own error names the remote, so the check prints git's exit status and nothing it wrote.
    const failed = spawnSync('git', ['ls-remote', 'origin'], {
      cwd: broken,
      env: { ...GIT_ENV, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
    });
    expect(failed.stderr).toContain(MARKER);
    expect(run.out).not.toContain(MARKER);
  });

  it('fails closed on a pull request whose head commit it cannot read', () => {
    for (const payload of [
      undefined,
      '{not json',
      null,
      { action: 'opened' },
      { pull_request: { head: { ref: 'feature/one' } } },
      pr(''),
      pr(42),
      pr(queued.slice(0, 7)),
      pr(`${main}\n`),
    ]) {
      const run = check('pull_request', payload);
      expect(run.status, JSON.stringify(payload)).toBe(1);
      expect(run.out).toMatch(/cannot read/u);
    }
  });

  it('passes a merge group and a push without listing anything', () => {
    for (const event of ['merge_group', 'push', 'pull_request_target']) {
      const run = check(event, pr(queued, 'gh-readonly-queue/main/pr-1-abc'), broken);
      expect(run.status, event).toBe(0);
      expect(run.out).not.toMatch(/could not list/u);
    }
  });
});

const tip = 'a'.repeat(39) + 'b';
const line = (sha: string, ref: string) => `${sha}\t${ref}\n`;

describe('reading the listing', () => {
  it('reads queue tips strictly: sha, tab, a ref under refs/heads/gh-readonly-queue/', () => {
    expect(queueTips('')).toStrictEqual(new Set());
    expect(
      queueTips(line(tip.toUpperCase(), 'refs/heads/gh-readonly-queue/main/pr-1')),
    ).toStrictEqual(new Set([tip]));
    for (const ref of [
      'refs/heads/x/gh-readonly-queue/main/pr-1',
      'refs/heads/x/refs/heads/gh-readonly-queue/main/pr-1',
      'refs/tags/gh-readonly-queue/main/pr-1',
      'refs/heads/gh-readonly-queue',
    ])
      expect(queueTips(line(tip, ref)), ref).toStrictEqual(new Set());
    // Anything not of that shape is a listing it cannot read.
    for (const text of [
      `${tip} refs/heads/gh-readonly-queue/main/pr-1\n`,
      line(tip.slice(1), 'refs/heads/gh-readonly-queue/main/pr-1'),
      line(`${tip}z`, 'refs/heads/gh-readonly-queue/main/pr-1'),
      `${tip}\trefs/heads/gh-readonly-queue/main/pr-1\r\n`,
      'fatal: no\n',
    ])
      expect(queueTips(text), text).toBeNull();
  });
});

describe('the decision', () => {
  it('reads the head commit and branch, lower-casing the commit', () => {
    expect(pullHead(pr(tip.toUpperCase(), 'feature/one'))).toStrictEqual({
      sha: tip,
      ref: 'feature/one',
    });
    for (const payload of [
      null,
      {},
      { pull_request: { head: { ref: 'feature/one' } } },
      { pull_request: { head: { sha: tip } } },
      pr(` ${tip}`),
      pr(tip.slice(1)),
    ])
      expect(pullHead(payload), JSON.stringify(payload)).toBeNull();
  });

  it('refuses a head that is exactly a tip, or a branch under the queue’s prefix, and nothing else', () => {
    const tips = new Set([tip]);
    expect(refusal({ sha: tip, ref: 'feature/one' }, tips)).toMatch(/merge-queue commit/u);
    expect(refusal({ sha: main, ref: 'gh-readonly-queue/main/pr-1' }, new Set())).toMatch(
      /gh-readonly-queue\//u,
    );
    expect(refusal({ sha: flip(tip), ref: 'feature/one' }, tips)).toBeNull();
    expect(refusal({ sha: tip.slice(0, 7), ref: 'feature/one' }, tips)).toBeNull();
    expect(refusal({ sha: `${tip}${'c'.repeat(24)}`, ref: 'feature/one' }, tips)).toBeNull();
    expect(refusal({ sha: main, ref: 'feature/gh-readonly-queue/main' }, tips)).toBeNull();
  });
});

describe('the wiring', () => {
  const ci = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: { gate: { name: string; steps: Record<string, unknown>[] } };
  };

  it('runs in the contamination gate right after the sent-back hold, unconditionally, before every other check', () => {
    const steps = ci.jobs.gate.steps;
    expect(ci.jobs.gate.name).toBe('contamination gate');
    const hold = steps.findIndex((s) => s['run'] === 'node scripts/sent-back-hold.mjs');
    const at = steps.findIndex((s) => s['run'] === 'node scripts/queue-head-check.mjs');
    expect(hold).toBeGreaterThan(-1);
    expect(at).toBe(hold + 1);
    expect(steps[at]).not.toHaveProperty('if');
    expect(steps[at]).not.toHaveProperty('continue-on-error');
    // Before it: only the checkout, the pinned Node and the hold.
    expect(
      steps
        .slice(0, hold)
        .every((s) => /^actions\/(checkout|setup-node)@/u.test(String(s['uses']))),
    ).toBe(true);
  });
});
