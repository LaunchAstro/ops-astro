// SPDX-License-Identifier: AGPL-3.0-only
// A throwaway repository for first-push cases. Its first commit carries this
// checkout's committed scanners (scripts/ and tests/gate/), so a push with no
// override runs the hook exactly as a real push does: each pushed commit
// judged by its own scanners. Every push is real, through the hook, into a bare
// repository on this machine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const source = resolve(import.meta.dirname, '../..');
export const hook = process.env.SOL_REVIEW_HOOK || join(source, '.husky/pre-push');

// Made-up keys, built at run time so no file holds one.
export const tokenShaped = () =>
  `${'ey'}J${randomBytes(12).toString('hex')}.${randomBytes(12).toString('hex')}`;
export const githubShaped = () => {
  let body = '';
  while (body.length < 36) {
    body += randomBytes(30)
      .toString('base64')
      .replaceAll(/[^A-Za-z0-9]/gu, '');
  }
  return `${'gh'}p_${body.slice(0, 36)}`;
};

export const scanned = (output) =>
  [...output.matchAll(/scanning what this push would publish: (\S+)/gu)].map((m) => m[1]);

// Settings that change what a scan reads; a case sets only those it means to.
const ambient = [
  'HUB_GATE_CMD',
  'HUB_PUBLIC_CONTENT_CMD',
  'HUB_GATE_TERMS',
  'HUB_GATE_LITERAL_HISTORY_RECEIPT',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'NODE_OPTIONS',
  'NODE_PATH',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
];

const identity = [
  '-c',
  'user.name=gate',
  '-c',
  'user.email=gate@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

const run = (cwd, args, env = process.env) =>
  spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 120000 });

const gitIn =
  (cwd) =>
  (...args) => {
    const result = run(cwd, args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };

const committedScanners = (repo) => {
  const archive = spawnSync('git', ['archive', 'HEAD', 'scripts', 'tests/gate'], {
    cwd: source,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(archive.status, 0, String(archive.stderr));
  const unpacked = spawnSync('tar', ['-x', '-C', repo], { input: archive.stdout });
  assert.equal(unpacked.status, 0, String(unpacked.stderr));
};

export const installHook = (repo) => {
  const wrapper = join(repo, '.git/hooks/pre-push');
  writeFileSync(wrapper, '#!/bin/sh\nexec sh -e "$FIRST_PUSH_HOOK" "$@"\n');
  chmodSync(wrapper, 0o755);
};

// gate and publicContent override the scanners; env adds any other setting.
// Every push brings the fixture's private list: a push without one is refused.
const pushFrom =
  (repo, terms) =>
  (remote, ref, { gate, publicContent, env = {} } = {}) => {
    const inherited = { ...process.env, FIRST_PUSH_HOOK: hook };
    for (const name of ambient) delete inherited[name];
    inherited.HUB_GATE_TERMS = terms;
    if (gate !== undefined) inherited.HUB_GATE_CMD = gate;
    if (publicContent !== undefined) inherited.HUB_PUBLIC_CONTENT_CMD = publicContent;
    const result = run(repo, ['push', remote, `${ref}:refs/heads/${ref}`], {
      ...inherited,
      ...env,
    });
    return { ...result, output: result.stdout + result.stderr };
  };

export function firstPushFixture(t, { gitleaksConfig, hooked = true } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'first-push-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const repo = join(scratch, 'local');
  // Outside the repository, as on a maintainer machine. One made-up term,
  // built at run time: the repository copies tests/gate, so a term written in
  // a test file would be found there.
  const terms = join(scratch, 'terms.txt');
  writeFileSync(terms, `zq${randomBytes(6).toString('hex')}\n`);
  const remotes = {
    origin: join(scratch, 'origin.git'),
    elsewhere: join(scratch, 'elsewhere.git'),
  };
  const git = gitIn(repo);
  const commit = (file, text, message) => {
    if (text === null) git('rm', '-q', file);
    else {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), text);
      git('add', file);
    }
    git(...identity, 'commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const published = (remote, ref) =>
    run(remotes[remote], ['rev-parse', '--verify', '-q', `refs/heads/${ref}`]).stdout.trim();

  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  for (const [name, path] of Object.entries(remotes)) {
    git('init', '-q', '--bare', path);
    git('remote', 'add', name, path);
  }
  committedScanners(repo);
  if (gitleaksConfig === undefined) {
    copyFileSync(join(source, '.gitleaks.toml'), join(repo, '.gitleaks.toml'));
  } else writeFileSync(join(repo, '.gitleaks.toml'), gitleaksConfig);
  writeFileSync(join(repo, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  git('add', '-A');
  git(...identity, 'commit', '-q', '-m', 'base');
  const base = commit('notes.txt', 'base notes\n', 'notes');
  if (hooked) installHook(repo);
  return { scratch, repo, terms, git, commit, push: pushFrom(repo, terms), published, base };
}
