// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const workflow = () => parse(readFileSync(join(root, '.github/workflows/sol-verdict.yml'), 'utf8'));

test('the advisory job runs on pull requests, formal review changes and merge groups', () => {
  const w = workflow();
  assert.deepEqual(w.on.pull_request.types, [
    'opened',
    'synchronize',
    'reopened',
    'labeled',
    'unlabeled',
  ]);
  assert.deepEqual(w.on.pull_request_review.types, ['submitted', 'edited', 'dismissed']);
  assert.ok(Object.hasOwn(w.on, 'merge_group'));
  assert.deepEqual(w.permissions, { contents: 'read', 'pull-requests': 'read' });
  assert.equal(w.jobs['sol-verdict'].name, 'Sol verdict for this revision');
  assert.ok(
    !readFileSync(join(root, '.github/required-checks.json'), 'utf8').includes(
      'Sol verdict for this revision',
    ),
  );
  assert.ok(!Object.hasOwn(w.on, 'pull_request_target'));
  assert.equal(
    w.jobs['sol-verdict'].steps.find((step) => step.name === 'Read the current records').shell,
    'bash',
  );
  for (const step of w.jobs['sol-verdict'].steps) assert.ok(!step['continue-on-error']);
});

function eventOf(group, pulls, base, queue) {
  return group
    ? {
        merge_group: {
          head_sha: queue,
          base_ref: 'refs/heads/main',
          head_ref: `refs/heads/gh-readonly-queue/main/pr-12-${base}`,
        },
      }
    : { pull_request: pulls[0] };
}

function repository(dir, git, group) {
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(dir, 'base.txt'), 'base');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', dir);
  const pulls = [];
  for (const number of [11, 12]) {
    git('checkout', '-qb', `pr${number}`, base);
    writeFileSync(join(dir, `${number}.txt`), `${number}`);
    git('add', '.');
    git('commit', '-qm', `change ${number}`);
    pulls.push({
      number,
      head: { sha: git('rev-parse', 'HEAD') },
      base: { sha: base, ref: 'main' },
      state: 'open',
      labels: [{ name: 'needs-sol' }],
    });
  }
  git('checkout', '-qb', 'queue', base);
  for (const p of pulls)
    git(
      'merge',
      '--no-ff',
      '-qm',
      `Merge pull request #${p.number} from fixture/pr${p.number}`,
      `pr${p.number}`,
    );
  const queue = git('rev-parse', 'HEAD');
  const event = eventOf(group, pulls, base, queue);
  symlinkSync(join(root, 'scripts'), join(dir, 'scripts'));
  writeFileSync(join(dir, 'event.json'), JSON.stringify(event));
  writeFileSync(join(dir, 'pulls.json'), JSON.stringify(pulls));
}

function fakeGh(dir) {
  mkdirSync(join(dir, 'bin'));
  writeFileSync(
    join(dir, 'bin/gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const endpoint = args.find(a => a.startsWith('repos/')).split('?')[0];
if (process.env.FAILURE && endpoint.endsWith(process.env.FAILURE)) process.exit(1);
const n = Number(endpoint.split('/')[4]);
const p = JSON.parse(fs.readFileSync('pulls.json')).find(p => p.number === n);
if (endpoint.endsWith('/comments') || endpoint.endsWith('/reviews')) {
  if (!args.includes('--paginate') || !args.includes('--slurp') || args.includes('--jq') || args.includes('--template')) process.exit(2);
  const body = 'Reviewer: Sol (Codex)\\nHead SHA: ' + p.head.sha + '\\nVerdict: ' + (process.env.NEGATIVE === 'yes' && n === 12 ? 'changes requested' : 'approve');
  const r = { id: n, body, user: { login: 'fixture-reviewer' }, updated_at: '2026-10-01T01:00:00Z', submitted_at: '2026-10-01T01:00:00Z' };
  console.log(JSON.stringify([endpoint.endsWith('/comments') ? [r] : []]));
} else { if (process.env.STALE === 'yes') p.head.sha = 'b'.repeat(40); console.log(JSON.stringify(p)); }
`,
    { mode: 0o755 },
  );
}

function runSteps(exec, env) {
  const results = [];
  for (const name of [
    'The pull requests being judged',
    'Read the current records',
    'Judge every pull request',
  ]) {
    const step = workflow().jobs['sol-verdict'].steps.find((candidate) => candidate.name === name);
    assert.ok(step, name);
    const out = exec('bash', ['-euo', 'pipefail', '-c', step.run], env);
    results.push(out);
    if (out.status !== 0) break;
  }
  return results.at(-1);
}

function exercise({
  group = false,
  negative = false,
  failure = '',
  stale = false,
  reviewEvent = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-workflow-'));
  const exec = (command, args, env = {}) =>
    spawnSync(command, args, {
      cwd: dir,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
  const git = (...args) => {
    const out = exec('git', [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ]);
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  try {
    const runner = join(dir, 'runner');
    mkdirSync(runner);
    repository(dir, git, group);
    fakeGh(dir);
    const env = {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      RUNNER_TEMP: runner,
      GITHUB_EVENT_NAME: group
        ? 'merge_group'
        : reviewEvent
          ? 'pull_request_review'
          : 'pull_request',
      GITHUB_EVENT_PATH: join(dir, 'event.json'),
      REPO: 'fixture/repository',
      SOL_REVIEWER_ACCOUNT: 'fixture-reviewer',
      FAILURE: failure,
      NEGATIVE: negative ? 'yes' : '',
      STALE: stale ? 'yes' : '',
    };
    return runSteps(exec, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [name, options] of [
  ['passes a pull request using its own full head', {}],
  ['passes a formal review event using the pull request head', { reviewEvent: true }],
  ['passes a group whose every member has positive evidence', { group: true }],
])
  test(name, () => {
    const out = exercise(options);
    assert.equal(out.status, 0, out.stdout + out.stderr);
  });

for (const [name, options] of [
  ['refuses a group when its second member has negative evidence', { group: true, negative: true }],
  ['refuses when the live pull request moved from the judged head', { stale: true }],
  ['refuses an unreadable pull request', { failure: '/11' }],
  ['refuses an unreadable comments response', { failure: '/comments' }],
  ['refuses an unreadable reviews response', { failure: '/reviews' }],
])
  test(name, () => {
    const out = exercise(options);
    assert.notEqual(out.status, 0, out.stdout + out.stderr);
  });
