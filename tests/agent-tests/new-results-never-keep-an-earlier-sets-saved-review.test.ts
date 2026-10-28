// SPDX-License-Identifier: AGPL-3.0-only
// Copied from the independent review of #1969 at 6126da6 (finding S1969-3), body unchanged.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'agent-tests-rerun-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const run = (...args: string[]) =>
  spawnSync(process.execPath, ['apps/agent-tests/main.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });

it("replacing results never keeps the earlier set's saved Astra review", () => {
  const out = join(scratch, 'reviewed.json');
  const source = join(scratch, 'astra.md');
  const saved = join(scratch, 'reviewed.astra-review.md');
  const luna = run('luna', '--out', out);
  expect(luna.status, luna.stderr).toBe(0);
  const original = readFileSync(out, 'utf8');
  writeFileSync(source, 'Reviewed the four Luna cases only.\n');
  const review = run('review', out, source);
  expect(review.status, review.stderr).toBe(0);
  expect(readFileSync(saved, 'utf8')).toBe('Reviewed the four Luna cases only.\n');

  const rerun = run('sol', '--out', out);
  const unchanged = readFileSync(out, 'utf8') === original;
  expect(
    unchanged || !existsSync(saved),
    `Exit ${rerun.status}: overwritten results still carry the Luna review; ${rerun.stdout}`,
  ).toBe(true);
});
