// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const VITEST = join(ROOT, 'node_modules/vitest/vitest.mjs');
const CONFIG = join(import.meta.dirname, 'temp-guard-fixture/vitest.config.ts');

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

/** One run of the planted fixture, with its temp folder and a neighbour's in scratch folders. */
function run(plantLeak: boolean) {
  const [temp, other] = [scratch('temp-guard-run-'), scratch('temp-guard-other-')];
  const done = spawnSync(process.execPath, [VITEST, 'run', '--config', CONFIG], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: temp, OTHER_RUN_TMP: other, PLANT_LEAK: plantLeak ? '1' : '' },
  });
  return { status: done.status, out: done.stdout + done.stderr, temp, other };
}

it('fails a run that leaves a folder behind in the temp folder, and removes it anyway', () => {
  const leaked = run(true);
  expect(leaked.status, leaked.out).not.toBe(0);
  expect(leaked.out).toMatch(/left 1 entry in the temp folder: planted-/u);
  expect(readdirSync(leaked.temp)).toStrictEqual([]);
}, 60_000);

it('passes the same run once the leak is removed, ignoring entries it did not create', () => {
  const clean = run(false);
  expect(clean.status, clean.out).toBe(0);
  expect(readdirSync(clean.temp)).toStrictEqual([]);
  expect(readdirSync(clean.other)).toHaveLength(1);
}, 60_000);
