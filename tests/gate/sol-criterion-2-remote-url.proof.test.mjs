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

test('Sol proof, criterion 2: changing a secondary remote URL must not publish unscanned history', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sol-remote-url-'));
  const repo = join(scratch, 'local');
  const previous = join(scratch, 'previous.git');
  const destination = join(scratch, 'destination.git');
  const run = (command, args, cwd = repo, env = process.env) =>
    spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 20000 });
  const git = (args, cwd = repo) => {
    const result = run('git', args, cwd);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    mkdirSync(repo);
    git(['init', '-q', '-b', 'main']);
    git(['init', '-q', '--bare', previous]);
    git(['init', '-q', '--bare', destination]);
    // Construct the synthetic refused value so the proof's source is publishable.
    writeFileSync(join(repo, 'note.txt'), `/${'Users'}/synthetic-person/Documents/private-note\n`);
    git(['add', 'note.txt']);
    git(['-c', 'user.name=gate', '-c', 'user.email=gate@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'note']);
    const tip = git(['rev-parse', 'HEAD']);
    git(['remote', 'add', 'secondary', previous]);
    git(['push', '-q', 'secondary', 'main']);
    git(['fetch', '-q', 'secondary']);
    assert.equal(git(['rev-parse', 'refs/remotes/secondary/main']), tip);
    assert.equal(run('git', ['show-ref'], destination).status, 1);

    const checker = run('node', [join(source, 'scripts/public-content-check.mjs'),
      '--repo', repo, '--range', tip]);
    assert.equal(checker.status, 1, checker.stdout + checker.stderr);
    assert.match(checker.stderr, /note\.txt \[personal-path\]/);

    // A normal URL change retains the previous repository's remote-tracking refs.
    git(['remote', 'set-url', 'secondary', destination]);
    assert.equal(git(['remote', 'get-url', 'secondary']), destination);
    assert.equal(git(['rev-parse', 'refs/remotes/secondary/main']), tip);
    const wrapper = join(repo, '.git/hooks/pre-push');
    writeFileSync(wrapper, '#!/bin/sh\nexec sh -e "$SOL_REVIEW_HOOK" "$@"\n');
    chmodSync(wrapper, 0o755);
    const result = run('git', ['push', 'secondary', 'main'], repo, {
      ...process.env,
      SOL_REVIEW_HOOK: hook,
      HUB_GATE_CMD: 'true',
      HUB_PUBLIC_CONTENT_CMD: `node ${join(source, 'scripts/public-content-check.mjs')}`,
    });
    const published = run('git', ['rev-parse', '--verify', 'refs/heads/main'], destination);
    assert.equal(result.status, 1,
      `Expected refusal, got push exit ${result.status}; destination received tip: ${published.stdout.trim() === tip}.\n${result.stdout}${result.stderr}`);
    assert.equal(published.status, 128, 'The fresh destination must remain empty');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
