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

test('a pushInsteadOf destination must not inherit history from a second insteadOf rewrite', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sol-double-url-rewrite-'));
  const repo = join(scratch, 'local');
  const privateRepo = join(scratch, 'private.git');
  const destination = join(scratch, 'public.git');
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
    git(['init', '-q', '--bare', privateRepo]);
    git(['init', '-q', '--bare', destination]);
    writeFileSync(join(repo, 'note.txt'), `/${'Users'}/synthetic-person/Documents/private-note\n`);
    git(['add', 'note.txt']);
    git(['-c', 'user.name=gate', '-c', 'user.email=gate@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'note']);
    const tip = git(['rev-parse', 'HEAD']);
    git(['push', '-q', privateRepo, 'main']);
    assert.equal(run('git', ['show-ref'], destination).status, 1);
    const checker = run('node', [join(source, 'scripts/public-content-check.mjs'),
      '--repo', repo, '--range', tip]);
    assert.equal(checker.status, 1, checker.stdout + checker.stderr);
    assert.match(checker.stderr, /note\.txt \[personal-path\]/);

    // Push rewriting resolves the alias to public.git only once. Passing that
    // resolved URL to a fresh Git command applies the fetch rewrite again.
    git(['remote', 'add', 'secondary', 'sol-review://destination']);
    git(['config', `url.${destination}.pushInsteadOf`, 'sol-review://destination']);
    git(['config', `url.${privateRepo}.insteadOf`, destination]);
    assert.equal(git(['remote', 'get-url', '--push', 'secondary']), destination);
    assert.equal(git(['ls-remote', '--', destination, 'refs/heads/main']), `${tip}\trefs/heads/main`);
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
      `Expected refusal, got push exit ${result.status}; public destination received tip: ${published.stdout.trim() === tip}.\n${result.stdout}${result.stderr}`);
    assert.equal(published.status, 128, 'The public destination must remain empty');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
