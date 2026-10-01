// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

it('the coloured summary proof fails when the named page capture is absent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'missing-named-capture-'));
  try {
    const archive = spawnSync('git', ['archive', 'HEAD'], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(archive.status, archive.stderr.toString()).toBe(0);
    const extracted = spawnSync('tar', ['-x', '-C', directory], { input: archive.stdout });
    expect(extracted.status, extracted.stderr.toString()).toBe(0);
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');

    const capture = join(directory, 'tests/surfaces/mp-1-1-tokens.test.tsx');
    const source = readFileSync(capture, 'utf8');
    const named = 'MP-1-1 harness captures: every built page';
    expect(source).toContain(named);
    writeFileSync(capture, source.replace(named, 'MP-1-1 removed capture: every built page'));

    const run = spawnSync(
      process.execPath,
      [
        join(directory, 'node_modules/vitest/vitest.mjs'),
        'run',
        'tests/visual/browser-proof-coloured-summary.test.ts',
      ],
      { cwd: directory, encoding: 'utf8' },
    );
    expect(run.status, `${run.stdout}\n${run.stderr}`).not.toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
