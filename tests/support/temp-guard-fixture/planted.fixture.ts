// SPDX-License-Identifier: AGPL-3.0-only
//
// The planted leak. With PLANT_LEAK=1 it leaves a folder in the temp folder;
// without it, it removes what it made. Either way it also makes a folder in
// OTHER_RUN_TMP, standing in for a run beside this one, which the guard must
// not count.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('makes a temp folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planted-'));
  mkdtempSync(join(process.env['OTHER_RUN_TMP'] ?? '', 'other-run-'));
  if (process.env['PLANT_CACHE_LEAK'] === '1') {
    const cache = join(tmpdir(), 'node-compile-cache');
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'sol-planted-leak'), 'this test made this entry');
  }
  if (process.env['PLANT_LEAK'] !== '1') rmSync(dir, { recursive: true, force: true });
  expect(dir).toBeTruthy();
});
