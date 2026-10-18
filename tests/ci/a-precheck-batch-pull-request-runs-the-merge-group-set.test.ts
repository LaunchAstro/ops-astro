// SPDX-License-Identifier: AGPL-3.0-only
//
// #1918: a pull request labelled `precheck-batch` from a branch of this repository decides as a
// merge group does, so a pre-check batch's green covers the units the queue runs. Run as the real
// scripts/ci-scope.ts process: on such a pull request `local checks` and `isolation tests` run
// their wrapped steps in full, and database conformance reads no change and gets no narrowed
// manifest. Without the label, with the label on a fork's pull request, or with another label,
// each decides as it does today. An event file that is named but unreadable runs nothing.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ROOT } from './merge-group-repo.ts';

const REPOSITORY = 'LaunchAstro/ops-astro';
const DEFERRED = ['local checks', 'isolation tests'];
/** A base no clone holds: a run that reads the change fails on it, one that does not never sees it. */
const UNREAD_BASE = 'b'.repeat(40);

const scratch = mkdtempSync(join(tmpdir(), 'precheck-batch-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Pull = { labels?: string[]; headRepo?: string | null };

let files = 0;
/** An event file for a pull request with these labels, its head on `headRepo`. */
function eventFile({ labels = [], headRepo = REPOSITORY }: Pull): string {
  files += 1;
  const path = join(scratch, `event-${files}.json`);
  const pull = {
    number: 7,
    labels: labels.map((name) => ({ name })),
    head: { sha: 'a'.repeat(40), repo: headRepo === null ? null : { full_name: headRepo } },
    base: { sha: UNREAD_BASE, ref: 'main' },
  };
  writeFileSync(path, JSON.stringify({ pull_request: pull }));
  return path;
}

/** scripts/ci-scope.ts for `check` on a pull request, deciding or wrapping `args`. */
function scope(check: string, path: string, ...args: string[]) {
  return spawnSync(process.execPath, ['scripts/ci-scope.ts', check, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: path,
      GITHUB_REPOSITORY: REPOSITORY,
    },
    encoding: 'utf8',
  });
}

const BATCH = eventFile({ labels: ['ci-next', 'precheck-batch'] });
const ORDINARY = [
  ['no label', eventFile({})],
  ['ci-next alone', eventFile({ labels: ['ci-next'] })],
  ['a look-alike label', eventFile({ labels: ['ci-next', 'Precheck-Batch', 'precheck-batch '] })],
  ['the label on a fork', eventFile({ labels: ['precheck-batch'], headRepo: 'someone/ops-astro' })],
  ['the label on a deleted fork', eventFile({ labels: ['precheck-batch'], headRepo: null })],
] as const;

describe('a pull request labelled precheck-batch', () => {
  it.each(DEFERRED)('%s runs its wrapped step in full, never deferring it', (check) => {
    const decided = scope(check, BATCH, '--decide');
    expect(`${decided.status} ${decided.stdout}`, decided.stderr).toBe('0 run\n');
    const run = scope(check, BATCH, '--', 'sh', '-c', 'exit 7');
    expect(run.status, run.stderr).toBe(7);
    expect(run.stderr).toMatch(/precheck-batch: runs in full/u);
    expect(run.stderr).not.toMatch(/deferred on a pull request/u);
  });

  it('database conformance reads no change and runs every suite, with no narrowed manifest', () => {
    const run = scope(
      'database conformance',
      BATCH,
      '--shard',
      '1/12',
      '--',
      process.execPath,
      '-e',
      'console.log(JSON.stringify(process.argv.slice(1)))',
      'conformance',
    );
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toStrictEqual(['conformance']);
    expect(run.stderr).toMatch(/precheck-batch: everything runs/u);
    expect(run.stderr).not.toMatch(/ci-scope: areas/u);
  });
});

describe('every other pull request decides as before', () => {
  it.each(ORDINARY)('%s: the queue-only checks defer', (_, path) => {
    for (const check of DEFERRED) {
      const decided = scope(check, path, '--decide');
      expect(`${decided.status} ${decided.stdout}`, `${check}: ${decided.stderr}`).toBe('0 skip\n');
      const run = scope(check, path, '--', 'sh', '-c', 'exit 7');
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).toMatch(/deferred on a pull request/u);
    }
  });

  it.each(ORDINARY)('%s: database conformance reads the change from its base', (_, path) => {
    // The base is not in any clone, so reading the change fails; the command never runs.
    const run = scope('database conformance', path, '--shard', '1/12', '--', 'sh', '-c', 'exit 7');
    expect(run.status, run.stderr).toBe(2);
  });

  it('an event file that is named but does not read runs nothing', () => {
    const broken = join(scratch, 'broken.json');
    writeFileSync(broken, '{ not json');
    for (const check of [...DEFERRED, 'database conformance']) {
      const run = scope(check, broken, '--', 'sh', '-c', 'exit 7');
      expect(run.status, `${check}: ${run.stderr}`).toBe(2);
    }
    const missing = scope('local checks', join(scratch, 'absent.json'), '--decide');
    expect(missing.status, missing.stderr).toBe(2);
    expect(missing.stdout).toBe('');
  });
});
