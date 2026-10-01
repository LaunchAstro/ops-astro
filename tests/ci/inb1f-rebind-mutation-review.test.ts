// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const CASE = 'a remapped login stops hearing the previous person';

function runMutated(path: string, before: string, after: string) {
  const snapshot = mkdtempSync(join(tmpdir(), 'ops-astro-rebind-mutation-'));
  try {
    const archive = spawnSync('git', ['archive', 'HEAD'], { cwd: ROOT, maxBuffer: 50_000_000 });
    expect(archive.status, archive.stderr.toString()).toBe(0);
    const unpacked = spawnSync('tar', ['-x', '-C', snapshot], { input: archive.stdout });
    expect(unpacked.status, unpacked.stderr.toString()).toBe(0);
    symlinkSync(join(ROOT, 'node_modules'), join(snapshot, 'node_modules'));
    const file = join(snapshot, path);
    const source = readFileSync(file, 'utf8');
    expect(source.split(before).length).toBe(2);
    writeFileSync(file, source.replace(before, after));
    const run = spawnSync(process.execPath, [
      join(snapshot, 'node_modules/vitest/vitest.mjs'), 'run',
      'tests/api/inb1f-live-board.test.ts', '-t', CASE, '--fileParallelism=false',
    ], { cwd: snapshot, env: process.env, encoding: 'utf8', timeout: 30_000 });
    expect(run.stdout + run.stderr).toContain('1 passed');
    return run.status;
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'the remapped-board case goes red when rebind is ignored',
  () => {
    const result = runMutated('apps/api/live-board.ts',
      "if (personId === bound.personId) return 'same';", "return 'same';");
    expect(result).not.toBe(0);
  }, 40_000,
);

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'the remapped-board case goes red when its inbox digest follows the previous person',
  () => {
    const result = runMutated('apps/api/app.ts',
      'await mayShowInbox(options, context, admitted.businessId, personId),',
      'await mayShowInbox(options, context, admitted.businessId, joined.personId),');
    expect(result).not.toBe(0);
  }, 40_000,
);
