// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { exportCandidate } from '../../scripts/candidate-snapshot.mjs';

const source = resolve(import.meta.dirname, '../..');
const guard = join(source, 'scripts/public-content-check.mjs');
const prohibited = ['synthetic', 'public', 'client'].join('');
const zero = '0'.repeat(40);

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-public-history-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  const commit = (message = 'chore: disposable fixture') => {
    git('add', '-A');
    git('commit', '--allow-empty', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  writeFileSync(join(repo, 'README.md'), 'A neutral public foundation.\n');
  const root = commit();
  const scan = (...args) =>
    spawnSync(process.execPath, [guard, '--repo', repo, ...args], { encoding: 'utf8' });
  try {
    run({ dir, repo, git, commit, root, scan });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a clean selected history passes and a single ref includes its root', () =>
  fixture(({ root, scan }) => {
    const result = scan('--range', root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 commit/u);
  }));

test('removed prohibited contents remain rejected by history when the staged tree is clean', () =>
  fixture(({ repo, root, commit, scan }) => {
    writeFileSync(join(repo, 'temporary.md'), prohibited);
    commit();
    rmSync(join(repo, 'temporary.md'));
    const head = commit();
    assert.equal(scan().status, 0, 'the clean staged tree alone cannot cover deleted history');
    const result = scan('--range', `${root}..${head}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /temporary.md \[excluded-token\]/u);
    assert.ok(!result.stderr.includes(prohibited));
  }));

test('removed prohibited paths remain rejected without disclosing their names', () =>
  fixture(({ repo, root, commit, scan }) => {
    const path = join(repo, `${prohibited}.md`);
    writeFileSync(path, 'ordinary contents');
    commit();
    rmSync(path);
    const head = commit();
    const result = scan('--range', `${root}..${head}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /<withheld-path> \[excluded-token\]/u);
    assert.ok(!result.stderr.includes(prohibited));
  }));

test('commit message policy findings survive behind a clean tip', () =>
  fixture(({ root, commit, scan }) => {
    commit(`chore: ${prohibited}`);
    const head = commit();
    const result = scan('--range', `${root}..${head}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /commit-[a-f0-9]+-metadata \[excluded-token\]/u);
    assert.ok(!result.stderr.includes(prohibited));
  }));

test('author metadata and the first root are scanned', () =>
  fixture(({ git, scan }) => {
    git('-c', `user.name=${prohibited}`, 'commit', '--amend', '--reset-author', '--no-edit', '-q');
    const result = scan('--range', git('rev-parse', 'HEAD'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /metadata \[excluded-token\]/u);
    assert.ok(!result.stderr.includes(prohibited));
  }));

test('the explicit range excludes unrelated branches and reports an empty range', () =>
  fixture(({ git, root, commit, scan }) => {
    git('checkout', '-qb', 'unrelated');
    commit(`chore: ${prohibited}`);
    git('checkout', '-q', 'main');
    const head = commit();
    assert.equal(scan('--range', `${root}..${head}`).status, 0);
    const empty = scan('--range', `${head}..${head}`);
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /0 commit/u);
    assert.equal(
      scan('--outgoing').status,
      1,
      'manual outgoing mode includes all unpublished branches',
    );
  }));

test('unknown ranges fail without printing private input', () =>
  fixture(({ scan }) => {
    const result = scan('--range', prohibited);
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes(prohibited));
  }));

test('real pre-push history guard refuses removed content and permits a clean selected ref', () =>
  fixture(({ dir, repo, root, commit }) => {
    const gate = join(dir, 'gate-stub');
    writeFileSync(gate, '#!/bin/sh\nexit 0\n');
    chmodSync(gate, 0o755);
    const run = (input) =>
      spawnSync('sh', ['-e', join(source, '.husky/pre-push')], {
        cwd: repo,
        input,
        encoding: 'utf8',
        env: {
          ...process.env,
          HUB_GATE_CMD: gate,
          HUB_PUBLIC_CONTENT_CMD: `${process.execPath} ${guard}`,
        },
      });
    assert.equal(run(`refs/heads/main ${root} refs/heads/main ${zero}\n`).status, 0);
    writeFileSync(join(repo, 'temporary.md'), prohibited);
    commit();
    rmSync(join(repo, 'temporary.md'));
    const head = commit();
    const denied = run(`refs/heads/main ${head} refs/heads/main ${root}\n`);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr + denied.stdout, /excluded-token/u);
    assert.equal(
      run(`refs/heads/main ${root} refs/heads/main ${zero}\n`).status,
      0,
      'a contaminated unrelated tip must not block the selected clean ref',
    );
    assert.equal(
      run(`refs/heads/main ${zero} refs/heads/main ${head}\n`).status,
      0,
      'deletions do not scan unrelated history',
    );
  }));

test('a shallow checkout cannot claim complete history coverage', () =>
  fixture(({ dir, repo }) => {
    const shallow = join(dir, 'shallow');
    execFileSync('git', ['clone', '--depth', '1', '--quiet', `file://${repo}`, shallow], {
      stdio: 'pipe',
    });
    const result = spawnSync(process.execPath, [guard, '--repo', shallow, '--range', 'HEAD'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /complete Git checkout/u);
  }));

test('annotated tags fail closed instead of silently discarding tag metadata', () =>
  fixture(({ git, scan }) => {
    git('-c', 'tag.gpgsign=false', 'tag', '-am', prohibited, 'annotated');
    const result = scan('--range', 'annotated');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /annotated tag publication is not supported/u);
    assert.ok(!result.stderr.includes(prohibited));
  }));

test('excluded operational tokens fail staged, exported and removed-history checks', () =>
  fixture(({ dir, repo, git, commit, root, scan }) => {
    const token = ['synthetic', 'operation', 'canary'].join('');
    writeFileSync(join(repo, 'context.md'), token);
    git('add', '.');
    const staged = scan();
    assert.equal(staged.status, 1);
    assert.match(staged.stderr, /excluded-token/u);
    const candidate = join(dir, 'candidate');
    const manifest = join(dir, 'manifest.json');
    exportCandidate(repo, candidate, manifest);
    const exported = spawnSync(
      process.execPath,
      [guard, '--candidate', candidate, '--manifest', manifest],
      { encoding: 'utf8' },
    );
    assert.equal(exported.status, 1);
    assert.match(exported.stderr, /excluded-token/u);
    commit();
    rmSync(join(repo, 'context.md'));
    const head = commit();
    const history = scan('--range', `${root}..${head}`);
    assert.equal(history.status, 1);
    assert.match(history.stderr, /excluded-token/u);
    assert.ok(
      ![staged.stderr, exported.stderr, history.stderr].some((output) => output.includes(token)),
    );
  }));
