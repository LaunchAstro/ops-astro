// SPDX-License-Identifier: AGPL-3.0-only
//
// The parity check probes every API route with a stub database (#2462). A route that faults
// under the probe answers 500 and printed its error while the check carried on, so a probe
// that judged nothing could still pass. The stub now answers what routes ask of it, and a
// probed route that faults is a parity failure.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');

it('--check prints no error and exits 0 on this tree', () => {
  const checked = spawnSync(process.execPath, ['scripts/command-parity.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(checked.stderr).toBe('');
  expect(checked.status).toBe(0);
}, 60_000);

it('a route that faults under the probe fails --check and is named', () => {
  // A copy of this tree whose operations read faults after its read runs, the way main's did
  // against the empty stub: the probe records the read, the route answers 500.
  const copy = mkdtempSync(join(tmpdir(), 'parity-fault-'));
  try {
    for (const directory of ['apps', 'packages', 'scripts']) {
      cpSync(join(root, directory), join(copy, directory), { recursive: true });
    }
    symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
    const appPath = join(copy, 'apps/api/app.ts');
    const original = readFileSync(appPath, 'utf8');
    const head =
      'async function operatesInstallation(database: Database, businessId: string): Promise<boolean> {';
    const faulting = original.replace(head, `${head}\n  throw new Error('a probed route faults');`);
    expect(faulting).not.toBe(original);
    writeFileSync(appPath, faulting);
    const checked = spawnSync(process.execPath, ['scripts/command-parity.mjs', '--check'], {
      cwd: copy,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(checked.error).toBeUndefined();
    expect(checked.stdout).toContain(
      'the route /api/b/b/operations/read faulted under the parity probe (500)',
    );
    expect(checked.status).toBe(1);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}, 120_000);
