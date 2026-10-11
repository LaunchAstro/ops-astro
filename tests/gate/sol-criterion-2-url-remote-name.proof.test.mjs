// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hook = process.env.SOL_REVIEW_HOOK || join(source, '.husky/pre-push');

test('Sol proof, criterion 2: a relative push URL matching another remote name must not exclude that remote history', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sol-url-remote-name-'));
  const repo = join(scratch, 'local');
  const previous = join(scratch, 'private.git');
  const destination = join(repo, 'public.git');
  const run = (command, args, cwd = repo, env = process.env) =>
    spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 20000 });
  const git = (args, cwd = repo) => {
    const result = run('git', args, cwd);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  try {
    mkdirSync(repo);
    git(['init', '-q', '-b', 'main']);
    git(['init', '-q', '--bare', previous]);
    git(['init', '-q', '--bare', destination]);
    writeFileSync(join(repo, 'note.txt'), `/${'Users'}/synthetic-person/Documents/private-note\n`);
    git(['add', 'note.txt']);
    git(['-c', 'user.name=gate', '-c', 'user.email=gate@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'note']);
    const tip = git(['rev-parse', 'HEAD']);
    git(['push', '-q', previous, 'main']);
    assert.equal(run('git', ['show-ref'], destination).status, 1);
    const checker = run('node', [join(source, 'scripts/public-content-check.mjs'),
      '--repo', repo, '--range', tip]);
    assert.equal(checker.status, 1, checker.stdout + checker.stderr);
    assert.match(checker.stderr, /note\.txt \[personal-path\]/u);

    // Push uses origin's relative path literally. ls-remote instead resolves
    // its repository argument as a configured remote name first.
    git(['remote', 'add', 'origin', 'public.git']);
    git(['remote', 'add', 'public.git', previous]);
    assert.equal(git(['config', '--get', 'remote.origin.url']), 'public.git');
    assert.equal(run('git', ['config', '--get-regexp', '^url\\..*\\.(push)?insteadof$']).status, 1);
    assert.equal(git(['ls-remote', '--', 'public.git', 'refs/heads/main']),
      `${tip}\trefs/heads/main`);
    const wrapper = join(repo, '.git/hooks/pre-push');
    writeFileSync(wrapper, '#!/bin/sh\nexec sh -e "$SOL_REVIEW_HOOK" "$@"\n');
    chmodSync(wrapper, 0o755);
    const result = run('git', ['push', 'origin', 'main'], repo, {
      ...process.env,
      SOL_REVIEW_HOOK: hook,
      HUB_GATE_CMD: 'true',
      HUB_PUBLIC_CONTENT_CMD: `node ${join(source, 'scripts/public-content-check.mjs')}`,
    });
    const published = run('git', ['rev-parse', '--verify', 'refs/heads/main'], destination);
    assert.equal(result.status, 1,
      `Expected refusal, got push exit ${result.status}; public destination received tip: ${published.stdout.trim() === tip}.\n${result.stdout}${result.stderr}`);
    assert.equal(published.status, 128, 'The public destination must remain empty');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
