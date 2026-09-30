// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');

it('a same-route API grant bypass fails parity', () => {
  const copy = mkdtempSync(join(tmpdir(), 'api-grant-parity-'));
  try {
    for (const directory of ['apps', 'packages', 'scripts']) {
      cpSync(join(root, directory), join(copy, directory), { recursive: true });
    }
    symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
    const parity = () =>
      spawnSync(process.execPath, ['scripts/command-parity.mjs', '--check'], {
        cwd: copy,
        encoding: 'utf8',
        timeout: 30_000,
      });
    const baseline = parity();
    expect(baseline.error).toBeUndefined();
    expect(baseline.status, baseline.stderr).toBe(0);

    const source = join(copy, 'packages/core-commands/src/reads/dispatch.ts');
    const original = readFileSync(source, 'utf8');
    const withoutGrant = original.replace(
      "if (row.authority !== 'holds-any-grant' && row.authority !== 'self') {",
      'if (false) {',
    );
    expect(withoutGrant).not.toBe(original);
    writeFileSync(source, withoutGrant);

    const bypassed = parity();
    expect(bypassed.error).toBeUndefined();
    expect(bypassed.status, bypassed.stdout + bypassed.stderr).toBe(1);
    expect(bypassed.stdout).toContain('grant');
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
