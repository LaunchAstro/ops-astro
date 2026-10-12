// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

test('an executable imported mjs with a query must be inspected', () => {
  const copy = mkdtempSync(join(tmpdir(), 'parity-query-import-'));
  try {
    for (const directory of ['apps', 'packages', 'scripts'])
      cpSync(join(root, directory), join(copy, directory), { recursive: true });
    symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
    const run = (args: string[]) =>
      spawnSync(process.execPath, args, {
        cwd: copy,
        encoding: 'utf8',
        timeout: 60_000,
      });
    const parity = () => run(['scripts/command-parity.mjs', '--check']);
    const baseline = parity();
    expect(baseline.status, baseline.stdout + baseline.stderr).toBe(0);
    writeFileSync(
      join(copy, 'packages/sol-query-helper.mjs'),
      "export function write() { return fetch('/api/b/alpha/sol-query-write', { method: 'POST' }); }\n",
    );
    appendFileSync(
      join(copy, 'apps/web/src/main.tsx'),
      "\nimport { write as solQueryWrite } from '../../../packages/sol-query-helper.mjs?browser';\nvoid solQueryWrite();\n",
    );
    const built = run([
      '--input-type=module',
      '-e',
      `
      import { build } from 'vite';
      import react from '@vitejs/plugin-react';
      import { resolve } from 'node:path';
      const result = await build({ configFile: false, root: resolve('apps/web'), logLevel: 'silent',
        publicDir: false, plugins: [react()], build: { write: false, minify: false },
        resolve: { alias: { '@launchastro/ui': resolve('packages/ui/src/index.ts') } } });
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(one => one.output);
      if (!outputs.some(one => one.type === 'chunk' && one.code.includes('sol-query-write')))
        throw new Error('the executable request did not ship');
    `,
    ]);
    expect(built.status, built.stdout + built.stderr).toBe(0);
    const result = parity();
    expect(
      result.status,
      'parity accepted a request emitted in the executable browser bundle',
    ).toBe(1);
    expect(result.stdout).toContain('sol-query-helper.mjs sends a request itself');
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}, 180_000);
