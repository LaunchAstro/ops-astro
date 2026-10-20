// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('malformed database addresses never print their password', () => {
  const marker = 'SOL1373-SYNTHETIC-PASSWORD';
  const root = join(import.meta.dirname, '../..');
  for (const name of ['DATABASE_URL', 'DATABASE_ADMIN_URL']) {
    for (const entry of ['operator', 'endings']) {
      const source =
        entry === 'operator'
          ? "import { requireOperatingOperator } from './scripts/ops/operator.ts'; const gate = await requireOperatingOperator(); console.error(JSON.stringify(gate)); process.exitCode = gate.ok ? 0 : 1;"
          : "import { main } from './apps/endings/loop.ts'; process.exitCode = await main(['--once'], process.env);";
      const run = spawnSync('node', ['--input-type=module', '-e', source], {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'],
          DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1:1/db',
          DATABASE_ADMIN_URL: 'postgres://synthetic:synthetic@127.0.0.1:1/db',
          GOTRUE_URL: 'http://127.0.0.1:1',
          SUPABASE_SERVICE_KEY: 'synthetic-service-key',
          OPS_ASTRO_TOKEN: 'synthetic-token',
          OPS_ASTRO_BUSINESS: 'alpha',
          OPS_ASTRO_DEPLOYMENTS: '/tmp/proof-unused-records',
          [name]: `postgres://synthetic:${marker}@127.0.0.1:invalid/db`,
        },
      });
      const output = run.stdout + run.stderr;
      expect(run.status, output).toBe(entry === 'operator' ? 1 : 2);
      expect(output).toContain(name);
      expect(output).not.toContain(marker);
      expect(output).not.toContain('ERR_INVALID_URL');
    }
  }
  // Four node processes, each loading the TypeScript entry and its imports:
  // 10 s on a loaded machine, past the 5 s default (#1536).
}, 30_000);
