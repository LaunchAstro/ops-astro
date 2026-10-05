// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
// eslint-disable-next-line max-lines-per-function -- the review's mutation check, kept as given
it('the flood suite rejects a quota that keeps every lapsed door', () => {
  const root = resolve(import.meta.dirname, '../..');
  const scratch = mkdtempSync(join(tmpdir(), 'sol-prv-oa-815-r1-cleanup-'));
  const quotaPath = 'apps/api/auth/agent-quota.ts';
  const testPath = 'tests/api/agent-quota-door-flood.test.ts';
  const source = readFileSync(join(root, quotaPath), 'utf8');
  const sweep = [
    '      for (const [old, window] of windows) {',
    '        if (at - window.start < WINDOW_MS) break;',
    '        windows.delete(old);',
    '      }',
  ].join('\n');
  assert.equal(source.split(sweep).length, 2, 'exactly one expiry sweep to disable');

  try {
    for (const file of [quotaPath, testPath])
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
    writeFileSync(join(scratch, quotaPath), source.replace(sweep, ''));
    writeFileSync(join(scratch, testPath), readFileSync(join(root, testPath)));
    symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ type: 'module' }));
    const config = join(scratch, 'vitest.config.mjs');
    writeFileSync(config, 'export default { test: { maxWorkers: 1, testTimeout: 30000 } };\n');
    const result = spawnSync(
      'corepack',
      ['pnpm', 'exec', 'vitest', 'run', '--root', scratch, '--config', config, testPath],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_ACTIONS: '', TMPDIR: scratch, TMP: scratch, TEMP: scratch },
        timeout: 120000,
      },
    );
    // The mutation's expected red stays out of the job log unless this check fails.
    const log = `Missing-expiry-sweep mutation\n${result.stdout}${result.stderr}`;
    assert.equal(result.error, undefined, `the mutation run completed\n${log}`);
    assert.notEqual(result.status, null, `the mutation run exited normally\n${log}`);
    if (result.status !== 0)
      assert.match(
        log,
        /AssertionError|expected .+ to /u,
        `a test assertion rejected the missing sweep\n${log}`,
      );
    assert.notEqual(
      result.status,
      0,
      `all three claimed proofs passed after expiry eviction was removed\n${log}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
