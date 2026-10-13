// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RECORD_TESTS } from '../../scripts/check-records.ts';

const ROOT = join(import.meta.dirname, '../..');
const BASE = '516dd3944424042beeafc51c702273f2b9a90df7';

/** A clone of this head whose record tests are healthy but for one planted file. */
function plantedClone(root: string): void {
  const sourceHead = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  expect(sourceHead.status, sourceHead.stderr).toBe(0);
  const clone = spawnSync('git', ['clone', '--quiet', '--shared', ROOT, root], {
    encoding: 'utf8',
  });
  expect(clone.status, clone.stderr).toBe(0);
  const checkout = spawnSync('git', ['checkout', '--quiet', '--detach', sourceHead.stdout.trim()], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(checkout.status, checkout.stderr).toBe(0);
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  for (const file of Object.values(RECORD_TESTS).flat()) {
    writeFileSync(
      join(root, file),
      "import { it, expect } from 'vitest';\nit('healthy record', () => expect(1).toBe(1));\n",
    );
  }
  writeFileSync(
    join(root, 'tests/ci/db-shards.test.ts'),
    [
      "import { it, afterAll } from 'vitest';",
      "import { existsSync, writeFileSync } from 'node:fs';",
      "const first = !existsSync('.hook-failed-once');",
      "afterAll(() => { if (first) { writeFileSync('.hook-failed-once', 'first'); throw new Error('SOL_REAL_HOOK_FAILURE'); } });",
      "it('times out on the first attempt', async () => {",
      '  if (first) await new Promise((done) => { setTimeout(done, 200); });',
      '}, 50);',
    ].join('\n'),
  );
}

it('a real afterAll failure beside a timeout in the same file fails the run', () => {
  const root = mkdtempSync(join(tmpdir(), 'records-hook-proof-'));
  try {
    plantedClone(root);
    const env = { ...process.env };
    delete env['DATABASE_URL'];
    delete env['DATABASE_ADMIN_URL'];
    const child = spawnSync(process.execPath, ['scripts/check-records.ts', '--base', BASE], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = `${child.stdout}\n${child.stderr}`;
    expect(child.error).toBeUndefined();
    expect(output).toContain('SOL_REAL_HOOK_FAILURE');
    expect(output).toContain('check-records: pass  lint ratchet');
    expect(output).toContain('check-records: pass  named suites kept');
    expect(child.status, 'A genuine failed cleanup hook must keep exit 1.\n' + output).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
