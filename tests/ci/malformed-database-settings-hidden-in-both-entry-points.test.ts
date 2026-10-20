// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('malformed database addresses never print their password in either entry point', () => {
  const canary = 'synthetic-url-password-canary';
  for (const key of ['DATABASE_URL', 'DATABASE_ADMIN_URL']) {
    for (const entry of ['operator', 'endings']) {
      const env = {
        PATH: process.env['PATH'],
        DATABASE_URL: 'postgres://synthetic@127.0.0.1:1/store',
        DATABASE_ADMIN_URL: 'postgres://synthetic@127.0.0.1:1/store',
        GOTRUE_URL: 'http://127.0.0.1:1',
        SUPABASE_SERVICE_KEY: 'synthetic-admin-key',
        OPS_ASTRO_TOKEN: 'synthetic-bearer',
        OPS_ASTRO_BUSINESS: 'synthetic',
        OPS_ASTRO_DEPLOYMENTS: '/tmp/never-written-sol1373',
        [key]: `postgres://owner:${canary}@[invalid/store`,
      };
      const code =
        entry === 'operator'
          ? "import { requireOperator } from './scripts/ops/operator.ts'; const gate = await requireOperator(); console.error(JSON.stringify(gate)); process.exitCode = gate.ok ? 0 : 1;"
          : "import { main } from './apps/endings/loop.ts'; process.exitCode = await main(['--once'], process.env);";
      const done = spawnSync('node', ['--input-type=module', '-e', code], {
        env,
        encoding: 'utf8',
      });
      expect(done.status, `${entry} must refuse ${key}`).toBe(entry === 'operator' ? 1 : 2);
      expect(done.stdout + done.stderr).toContain(key);
      expect(done.stdout + done.stderr).not.toContain(canary);
    }
  }
  // Four node processes, each loading a TypeScript entry and its imports: 3.7 to 4.1 s in green
  // merge groups and 6.0 s in the group it sank (run 38374187832), past the 5 s default (#1536).
  // The same limit as malformed-database-settings-print-no-password.test.ts.
}, 30_000);
