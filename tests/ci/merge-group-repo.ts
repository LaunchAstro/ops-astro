// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-QUEUE: a repository shaped like a merge queue's build, and the payloads GitHub sends for it,
// for tests/ci/merge-group*.test.ts. The fixtures are tests/ci/fixtures/*-event.json.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ROOT: string = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/merge-group.mjs');
export const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const dirs: string[] = [];
/** Removes every repository made here; each test file calls it in afterAll. */
export const cleanup = (): void => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));

export const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

export interface Repo {
  dir: string;
  git: (...args: string[]) => string;
  commit: (file: string, message: string) => string;
  merge: (branch: string, message: string) => string;
  /** main's tip, the two pull requests' heads, and the queue's merge of each. */
  main: string;
  pr11: string;
  pr12: string;
  g11: string;
  g12: string;
}

/** A repository whose `origin` is itself, so `git fetch origin main` reads its own main. */
export function repo(): Repo {
  const dir: string = mkdtempSync(join(tmpdir(), 'merge-group-'));
  dirs.push(dir);
  const git = (...args: string[]): string => {
    const r = spawnSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', dir);
  const commit = (file: string, message: string): string => {
    writeFileSync(join(dir, file), `${message}\n`);
    git('add', file);
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const main = commit('README.md', 'docs: start');
  git('checkout', '-q', '-b', 'pr11', main);
  const pr11 = commit('a.txt', 'feat: a');
  git('checkout', '-q', '-b', 'pr12', main);
  const pr12 = commit('b.txt', 'feat: b');
  // The queue's temporary branch: main, then each queued pull request merged on top.
  git('checkout', '-q', '-b', 'queue', main);
  const merge = (branch: string, message: string): string => {
    git('merge', '-q', '--no-ff', branch, '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const g11 = merge('pr11', 'Merge pull request #11 from LaunchAstro/pr11');
  const g12 = merge('pr12', 'Merge pull request #12 from LaunchAstro/pr12');
  return { dir, git, commit, merge, main, pr11, pr12, g11, g12 };
}

/** A fixture payload with its placeholders filled. */
export function payload(dir: string, name: string, fill: Record<string, string>): string {
  let text = read(`tests/ci/fixtures/${name}`);
  for (const [k, v] of Object.entries(fill)) text = text.replaceAll(`@${k}@`, v);
  const path = join(dir, '.event.json');
  writeFileSync(path, text);
  return path;
}

export const group = (dir: string, head: string, ref: string, base = 'main'): string =>
  payload(dir, 'merge-group-event.json', {
    HEAD: head,
    HEAD_REF: `refs/heads/gh-readonly-queue/${base}/pr-${ref}`,
    BASE_REF: `refs/heads/${base}`,
  });

export function run(
  dir: string,
  event: string,
  eventPath: string,
  args: string[],
  extra = {},
): SpawnSyncReturns<string> {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: dir,
    env: { ...ENV, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath, ...extra },
    encoding: 'utf8',
  });
}
