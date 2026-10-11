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

test('a canonical SSH URL does not prove the receiver holds public main', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sol-ssh-destination-'));
  const repo = join(scratch, 'local');
  const published = join(scratch, 'published.git');
  const destination = join(scratch, 'new-destination.git');
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
    git(['init', '-q', '--bare', published]);
    git(['init', '-q', '--bare', destination]);
    writeFileSync(join(repo, 'note.txt'), `/${'Users'}/synthetic-person/Documents/private-note\n`);
    git(['add', 'note.txt']);
    git(['-c', 'user.name=gate', '-c', 'user.email=gate@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'note']);
    const tip = git(['rev-parse', 'HEAD']);
    git(['push', '-q', published, 'main']);
    assert.equal(run('git', ['show-ref'], destination).status, 1);
    const checker = run('node', [join(source, 'scripts/public-content-check.mjs'),
      '--repo', repo, '--range', tip]);
    assert.equal(checker.status, 1, checker.stdout + checker.stderr);
    assert.match(checker.stderr, /note\.txt \[personal-path\]/u);

    // This is a deterministic SSH transport stand-in. core.sshCommand can
    // select an SSH config whose Host github.com has a different HostName.
    // Git still gives the hook the canonical URL, while the receiver is new.
    const ssh = join(scratch, 'ssh');
    writeFileSync(ssh, '#!/bin/sh\nexec git-receive-pack "$SOL_SSH_DESTINATION"\n');
    chmodSync(ssh, 0o755);
    git(['config', 'core.sshCommand', ssh]);
    git(['config', 'ssh.variant', 'simple']);
    git(['remote', 'add', 'secondary', `git@${'github.com'}:LaunchAstro/ops-astro.git`]);
    // No origin/main exists: the old hook scans the full history and refuses.
    assert.equal(run('git', ['rev-parse', '--verify', 'refs/remotes/origin/main']).status, 128);
    const wrapper = join(repo, '.git/hooks/pre-push');
    writeFileSync(wrapper, '#!/bin/sh\nexec sh -e "$SOL_REVIEW_HOOK" "$@"\n');
    chmodSync(wrapper, 0o755);
    const result = run('git', ['push', 'secondary', 'main'], repo, {
      ...process.env,
      SOL_REVIEW_HOOK: hook,
      SOL_SSH_DESTINATION: destination,
      // The same public-main fixture seam used by the committed hook cases.
      HUB_PUBLISHED_URL: published,
      HUB_GATE_CMD: 'true',
      HUB_PUBLIC_CONTENT_CMD: `node ${join(source, 'scripts/public-content-check.mjs')}`,
    });
    const received = run('git', ['rev-parse', '--verify', 'refs/heads/main'], destination);
    assert.equal(result.status, 1,
      `Expected refusal, got push exit ${result.status}; new destination received refused tip: ${received.stdout.trim() === tip}.\n${result.stdout}${result.stderr}`);
    assert.equal(received.status, 128, 'The new destination must remain empty');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
