// SPDX-License-Identifier: AGPL-3.0-only
//
// Parity reads every module the web app ships: the UI kit it imports from
// packages/ui and a plain script module the app imports. A copy of the
// sources has a direct request planted in each, and `--check` names both.

import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const POST = "fetch('/api/b/alpha/unregistered-write', { method: 'POST', body: '{}' });";

it('names a direct request in an imported UI kit component and in a script module', () => {
  const copy = mkdtempSync(join(tmpdir(), 'parity-shipped-modules-'));
  try {
    for (const directory of ['apps', 'packages', 'scripts']) {
      cpSync(join(root, directory), join(copy, directory), { recursive: true });
    }
    symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
    appendFileSync(
      join(copy, 'packages/ui/src/kit/controls.tsx'),
      `\nexport const plantedWrite = () => ${POST}\n`,
    );
    writeFileSync(
      join(copy, 'apps/web/src/data/planted-helper.mjs'),
      `export const plantedWrite = () => ${POST}\n`,
    );
    // Imported and called, so the build ships it.
    appendFileSync(
      join(copy, 'apps/web/src/main.tsx'),
      "\nimport { plantedWrite } from './data/planted-helper.mjs';\nplantedWrite();\n",
    );
    const result = spawnSync(process.execPath, ['scripts/command-parity.mjs', '--check'], {
      cwd: copy,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('packages/ui/src/kit/controls.tsx sends a request itself');
    expect(result.stdout).toContain('data/planted-helper.mjs sends a request itself');
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}, 120_000);
