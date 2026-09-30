// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(process.env['DATABASE_URL'] === undefined)(
  'the required two-URL proof step fails when its test skips',
  () => {
    const root = join(import.meta.dirname, '../..');
    const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true' };
    delete env['DATABASE_ADMIN_URL'];
    const run = spawnSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', 'tests/ci/named-service-stop-proof-two-urls.test.ts'],
      { cwd: root, env, encoding: 'utf8' },
    );
    expect(`${run.stdout}${run.stderr}`).toMatch(/Tests\s+1 skipped/u);
    expect(run.status).not.toBe(0);
  },
  30_000,
);
