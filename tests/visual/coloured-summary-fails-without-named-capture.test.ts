// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { unpackHead } from './head-snapshot.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

it('the coloured summary proof fails when the named page capture is absent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'missing-named-capture-'));
  try {
    unpackHead(root, directory);

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
