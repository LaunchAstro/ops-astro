// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');

test('the committed anchored-key fixtures reach the pin validator', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sol-1365-loader-'));
  try {
    for (const path of ['scripts', '.github/workflows', 'docs'])
      mkdirSync(join(dir, path), { recursive: true });
    copyFileSync(join(root, 'scripts/pins-check.mjs'), join(dir, 'scripts/pins-check.mjs'));
    writeFileSync(join(dir, 'docs/supply-chain-pins.md'), 'no pins\n');
    const workflow = 'jobs:\n  a:\n    steps:\n      - &action "us\\u0065s": actions/checkout@v4\n';
    expect(parse(workflow).jobs.a.steps[0].uses).toBe('actions/checkout@v4');
    writeFileSync(join(dir, '.github/workflows/ci.yml'), workflow);
    const args = [join(dir, 'scripts/pins-check.mjs')];
    const unloaded = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(unloaded.status).toBe(1);
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    const loaded = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(loaded.status).toBe(1);
    expect(loaded.stderr).toContain('actions/checkout@v4 is not pinned');
    expect(unloaded.stderr).toContain('actions/checkout@v4 is not pinned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
