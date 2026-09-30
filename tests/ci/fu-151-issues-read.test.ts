// SPDX-License-Identifier: AGPL-3.0-only
//
// FU-151 (issue #151): the hosted review-evidence job could not see open issues. Its token held
// `contents: read` and `pull-requests: read` only, so GitHub's issue listing gave it pull requests
// and no issues, OPEN_ISSUES came out empty, and every `filed as follow-up #<n>` outcome failed as
// "not an open issue" (hosted run 36536199611). The fix grants `issues: read` and nothing else.
//
// These cases run the job's own two steps, as the workflow file holds them, against a stand-in for
// GitHub that answers only what the job's granted permissions let a token see. The hosted run on
// the pull request is the proof against GitHub itself.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { script, step, top } from './workflow-text.ts';

const ROOT = join(import.meta.dirname, '../..');
const REVIEW = readFileSync(join(ROOT, '.github/workflows/review-evidence.yml'), 'utf8');
const FETCH = 'Read the description as it stands now';
const BINDS = 'The review must cover the head being merged';

/**
 * The permissions the review-evidence job's token holds: its own block if it has one, which
 * replaces the workflow's, otherwise the workflow's.
 */
function granted(): Record<string, string> {
  const job = top(REVIEW, 'jobs');
  const own = /^ {4}permissions:\n((?: {6}.*\n)*)/mu.exec(job)?.[1];
  const lines = own ?? top(REVIEW, 'permissions').split('\n').slice(1).join('\n');
  return Object.fromEntries(
    [...lines.matchAll(/^ +([\w-]+): *(\S+) *$/gmu)].map((m) => [m[1] ?? '', m[2] ?? '']),
  );
}

// A stand-in for `gh api`: the rows a token with the job's permissions is shown. #5 is an open
// issue, #6 a closed issue, #7 an open pull request; any other number does not exist. As GitHub
// does, the issue listing holds issues only for a token that may read them, and pull requests for
// one that may read those. The `--jq` filter runs through jq, as gh runs it.
const GH = String.raw`#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const may = (scope) => (process.env.STUB_GRANTED ?? '').split(',').includes(scope + ':read');
const fail = (why) => { process.stderr.write('gh: ' + why + '\n'); process.exit(1); };
if (args[0] !== 'api') fail('only api is stood in');
if (process.env.GH_TOKEN !== process.env.STUB_TOKEN) fail('HTTP 401: Bad credentials');
const jq = args[args.indexOf('--jq') + 1];
const path = args.find((a, i) => i > 0 && !a.startsWith('--') && args[i - 1] !== '--jq');
const url = new URL(path, 'https://api.github.invalid/');
let answer;
if (url.pathname === '/repos/o/r/pulls/9') {
  if (!may('pull-requests')) fail('HTTP 403: Resource not accessible by integration');
  const labels = (process.env.STUB_LABELS ?? '').split(',').filter(Boolean);
  answer = { body: process.env.STUB_BODY, labels: labels.map((name) => ({ name })) };
} else if (url.pathname === '/repos/o/r/issues') {
  const state = url.searchParams.get('state') ?? 'open';
  const rows = [
    { number: 5, state: 'open' },
    { number: 6, state: 'closed' },
    { number: 7, state: 'open', pull_request: {} },
  ];
  answer = rows
    .filter((r) => state === 'all' || r.state === state)
    .filter((r) => (r.pull_request === undefined ? may('issues') : may('pull-requests')));
} else fail('HTTP 404: Not Found');
const out = spawnSync('jq', ['-r', jq], { input: JSON.stringify(answer), encoding: 'utf8' });
if (out.status !== 0) fail('jq: ' + out.stderr);
process.stdout.write(out.stdout);
`;

const HEAD = '1'.repeat(40);
// A planted token: the job's steps must never print it, whatever they print.
const CANARY = 'ghs_fu151CanaryTokenNeverPrinted';
const body = (issue: number) =>
  [
    `Review checkpoint\n  head:        ${HEAD}`,
    `Code review: 1 finding, 0 closed, 1 filed as follow-up #${String(issue)}`,
    'Security review: not required: no sensitive paths changed',
    `Reviewer: Sol (Codex)\nModel: gpt-6-sol\nHead SHA: ${HEAD}\nVerdict: approve`,
  ].join('\n\n');

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** The job's fetch step, then its check step, for a body naming `issue` as the follow-up. */
function runJob(issue: number, labels = '', text = body(issue)) {
  const dir = mkdtempSync(join(tmpdir(), 'fu151-'));
  made.push(dir);
  writeFileSync(join(dir, 'gh'), GH);
  chmodSync(join(dir, 'gh'), 0o755);
  // Nothing from the machine running the cases answers for the job.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(GH_|GITHUB_|OPEN_ISSUES$|PR_BODY$|PR_LABELS$|BASE_SHA$|CHANGED_FILES$)/u.test(k),
    ),
  );
  const perms = Object.entries(granted()).map(([k, v]) => `${k}:${v}`);
  const bash = (name: string, extra: Record<string, string>) =>
    spawnSync('bash', ['-e', '-c', script(step(REVIEW, name))], {
      cwd: ROOT,
      env: { ...env, RUNNER_TEMP: dir, ...extra },
      encoding: 'utf8',
    });
  const fetched = bash(FETCH, {
    PATH: `${dir}:${process.env['PATH'] ?? ''}`,
    GH_TOKEN: CANARY,
    STUB_TOKEN: CANARY,
    REPO: 'o/r',
    PR_NUMBER: '9',
    STUB_GRANTED: perms.join(','),
    STUB_BODY: text,
    STUB_LABELS: labels,
  });
  const checked = bash(BINDS, {
    HEAD_SHA: HEAD,
    CHANGED_FILES: 'README.md',
    AGENT_MODELS: 'claude-opus-5-5',
  });
  const listed = readFileSync(join(dir, 'open-issues.txt'), 'utf8').split('\n').filter(Boolean);
  return { fetched, checked, listed };
}

const UNFILED = 'names a follow-up that is not an open issue in this repository';

describe('FU-151 the review-evidence job reads open issues', () => {
  it('FU-151 permissions: the job gains issues: read and nothing else', () => {
    expect(granted()).toEqual({ contents: 'read', 'pull-requests': 'read', issues: 'read' });
    expect(REVIEW.match(/secrets\.|GITHUB_TOKEN|write|pull_request_target/u)).toBeNull();
  });

  it('FU-151 listing: the open-issue list the job reads is non-empty when open issues exist', () => {
    const { fetched, listed } = runJob(5);
    expect(fetched.stderr).toBe('');
    expect(fetched.status).toBe(0);
    // The open issue only: not the closed one, not the open pull request.
    expect(listed).toEqual(['5']);
  });

  it('FU-151 follow-up: a follow-up naming an open issue passes the check', () => {
    const { checked } = runJob(5);
    expect(checked.stderr).not.toContain(UNFILED);
    expect(checked.status).toBe(0);
  });

  it.each([
    ['a closed issue', 6],
    ['a pull request', 7],
    ['a missing number', 404],
  ])('FU-151 follow-up: a follow-up naming %s is refused', (_, issue) => {
    const { fetched, checked } = runJob(issue);
    expect(fetched.status).toBe(0);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain(UNFILED);
    expect(checked.stderr).toContain(`follow-up #${String(issue)}`);
  });

  it.each([5, 6])('FU-151 token: neither step prints the token (follow-up #%i)', (issue) => {
    const { fetched, checked } = runJob(issue);
    const output = [fetched, checked].flatMap((r) => [r.stdout, r.stderr]).join('\n');
    expect(output).not.toContain(CANARY);
  });
});

describe('Sol owed: the review-evidence job reads the labels', () => {
  // Owner, 1 October 2026: the `needs-sol` label and a `Sol-owed:` line stand in for the record.
  const owed = body(5).replace(/Reviewer:[\s\S]*$/u, 'Sol-owed: stage1/SOL-OWED.md MAIN-GATE-1');
  it('Sol owed: the job reads the needs-sol label GitHub shows and accepts the mark', () => {
    const { fetched, checked } = runJob(5, 'mock,needs-sol', owed);
    expect(fetched.status).toBe(0);
    expect(checked.status).toBe(0);
  });

  it('Sol owed: without the label on the pull request the job refuses the mark', () => {
    const { checked } = runJob(5, 'mock', owed);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain('not the `needs-sol` label');
  });
});
