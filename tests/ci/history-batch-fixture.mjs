// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicHistory, scanPublicFiles } from '../../scripts/public-content-check.mjs';

const source = resolve(import.meta.dirname, '../..');
const guard = join(source, 'scripts/public-content-check.mjs');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
export const ceiling = 64 * 1024 * 1024;

function fixtureRepository(repo) {
  const git = (...args) =>
    execFileSync(realGit, ['--no-replace-objects', '-C', repo, ...args], {
      stdio: 'pipe',
      maxBuffer: ceiling,
    });
  const text = (...args) =>
    git(...args)
      .toString()
      .trim();
  text('init', '-q', '-b', 'main');
  text('config', 'user.name', 'Fixture');
  text('config', 'user.email', 'fixture@example.invalid');
  text('config', 'commit.gpgsign', 'false');
  text('config', 'core.hooksPath', '/dev/null');
  const commit = (message = 'chore: disposable history fixture') => {
    text('add', '-A');
    text('commit', '--allow-empty', '-qm', message);
    return text('rev-parse', 'HEAD');
  };
  return { git, text, commit, root: commit() };
}

function withGitWrapper(bin, log, mode, action) {
  const replacements = {
    PATH: `${bin}:${process.env.PATH}`,
    HISTORY_BATCH_FAULT: mode,
    HISTORY_BATCH_GIT: realGit,
    HISTORY_BATCH_LOG: log,
  };
  const originals = Object.fromEntries(
    Object.keys(replacements).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, replacements);
  try {
    return action();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function historyFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'public-history-batch-'));
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  const log = join(dir, 'git-calls.jsonl');
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(log, '');
  const repository = fixtureRepository(repo);
  const wrapper = join(bin, 'git');
  const implementation = pathToFileURL(join(source, 'tests/ci/history-batch-git.mjs')).href;
  writeFileSync(
    wrapper,
    `#!${process.execPath}\nawait import(${JSON.stringify(implementation)});\n`,
  );
  chmodSync(wrapper, 0o755);
  const history = (mode = '') => withGitWrapper(bin, log, mode, () => publicHistory(repo, 'HEAD'));
  const cli = (mode = '') =>
    withGitWrapper(bin, log, mode, () =>
      spawnSync(process.execPath, [guard, '--repo', repo, '--range', 'HEAD'], { encoding: 'utf8' }),
    );
  const calls = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  try {
    run({ dir, repo, ...repository, history, cli, calls, source });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function typedHistory(git) {
  const commits = git('rev-list', 'HEAD').toString().trim().split('\n').filter(Boolean);
  const files = [];
  const seen = new Set();
  for (const oid of commits) {
    files.push({
      path: `commit-${oid}-metadata`,
      bytes: git('cat-file', 'commit', oid),
      scope: 'commit',
    });
    for (const record of git('ls-tree', '-rz', '--full-tree', oid)
      .toString('utf8')
      .split('\0')
      .filter(Boolean)) {
      const tab = record.indexOf('\t');
      const blob = record.slice(0, tab).split(' ')[2];
      const path = record.slice(tab + 1);
      const pair = `${blob}\0${path}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      files.push({ path, bytes: git('cat-file', 'blob', blob) });
    }
  }
  return { files, commits: commits.length, blobPaths: seen.size };
}

export { scanPublicFiles };
