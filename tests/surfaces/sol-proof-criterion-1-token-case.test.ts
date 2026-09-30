// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

it('Sol proof, criterion 1: case-distinct custom properties cannot hide token drift', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sol-proof-criterion-1-'));
  try {
    const css = join(directory, 'tokens.css');
    const expected = join(directory, 'expected.json');
    writeFileSync(
      css,
      ":root { --ink: red; --Ink: blue; } [data-theme='dark'] { --ink: red; --Ink: blue; }",
    );
    writeFileSync(
      expected,
      JSON.stringify({ light: { '--ink': 'blue' }, dark: { '--ink': 'blue' } }),
    );

    const run = spawnSync(
      process.execPath,
      [`${root}scripts/token-diff.mjs`, '--css', css, '--expected', expected],
      { encoding: 'utf8' },
    );
    expect(run.status, run.stdout + run.stderr).toBe(1);
    expect(run.stderr).toContain('light --ink: want blue, got red');
    expect(run.stderr).toContain('dark --ink: want blue, got red');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
