// SPDX-License-Identifier: AGPL-3.0-only
//
// #1626 R11: Astra's review is saved beside the results file it reviews, by
// the real command. It refuses, writing nothing, when the file it names is
// not a results file, and it never writes over a review already saved.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const dir = mkdtempSync(join(tmpdir(), 'agent-review-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (...args: string[]) =>
  spawnSync(process.execPath, ['apps/agent-tests/main.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });

it('saves the review beside the results file, and never over one already there', () => {
  const results = join(dir, 'luna.json');
  expect(run('luna', '--out', results).status).toBe(0);
  const review = join(dir, 'astra.md');
  writeFileSync(review, 'Every case reads as its outcome says.\n');

  const saved = run('review', results, review);
  expect(saved.status, saved.stderr).toBe(0);
  const beside = join(dir, 'luna.astra-review.md');
  expect(readFileSync(beside, 'utf8')).toBe('Every case reads as its outcome says.\n');

  writeFileSync(review, 'A second review.\n');
  const again = run('review', results, review);
  expect(again.status).toBe(2);
  expect(again.stderr).toContain('already saved');
  expect(readFileSync(beside, 'utf8')).toBe('Every case reads as its outcome says.\n');
});

it('refuses to save a review beside a file that is not a results file', () => {
  const other = join(dir, 'notes.json');
  writeFileSync(other, JSON.stringify({ hello: 'world' }));
  const review = join(dir, 'review.md');
  writeFileSync(review, 'Looks fine.\n');

  const done = run('review', other, review);
  expect(done.status).toBe(2);
  expect(done.stderr).toContain('not a results file');
  expect(existsSync(join(dir, 'notes.astra-review.md'))).toBe(false);
});
