// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

// The look probes of every screen (tests/visual/look/*.ts), held to the values
// pinned from the mockup. look.ts serves the app from source, draws it from the
// made-up reads and prints one line per probe, width and theme; a red line
// names the property and both values.
it('every screen matches the pinned mockup on its look probes', () => {
  const out = mkdtempSync(join(tmpdir(), 'look-'));
  try {
    const run = spawnSync(process.execPath, ['tests/visual/look.ts', '--out', out], {
      cwd: root,
      encoding: 'utf8',
      timeout: 540_000,
    });
    const red = run.stdout.split('\n').filter((line) => line.startsWith('red '));
    expect(red, run.stderr).toEqual([]);
    expect(run.status, run.stdout.slice(-2000) + run.stderr).toBe(0);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 600_000);
