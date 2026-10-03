// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const NAMED = 'tests/api/live-task-frame-no-identifier-review.test.ts';

it('Sol proof, criterion 7: the dedicated task-frame proof fails when notification frames export the task identifier', () => {
  const snapshot = mkdtempSync(join(tmpdir(), 'sol-ow001-frame-mutation-'));
  try {
    const archive = spawnSync('git', ['archive', 'HEAD'], { cwd: ROOT, maxBuffer: 50_000_000 });
    expect(archive.status, archive.stderr.toString()).toBe(0);
    const unpacked = spawnSync('tar', ['-x', '-C', snapshot], { input: archive.stdout });
    expect(unpacked.status, unpacked.stderr.toString()).toBe(0);
    symlinkSync(join(ROOT, 'node_modules'), join(snapshot, 'node_modules'));
    const file = join(snapshot, 'apps/api/app.ts');
    const source = readFileSync(file, 'utf8');
    const before =
      "else if (signal !== 'check') await stream.writeSSE({ event: signal, data: '' });";
    const after =
      "else if (signal !== 'check') await stream.writeSSE({ event: signal, data: taskId });";
    expect(source.split(before)).toHaveLength(2);
    writeFileSync(file, source.replace(before, after));
    const run = spawnSync(
      process.execPath,
      [join(snapshot, 'node_modules/vitest/vitest.mjs'), 'run', NAMED, '--reporter=verbose'],
      {
        cwd: snapshot,
        env: process.env,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(run.error).toBeUndefined();
    expect(run.stdout + run.stderr).toContain(
      'a dedicated task stream frame carries no task or client identifier',
    );
    expect(
      run.status,
      'The named proof must go red when every later notification frame carries the protected task identifier.',
    ).not.toBe(0);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}, 40_000);
