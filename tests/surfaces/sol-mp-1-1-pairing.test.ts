// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

it('Sol proof, criterion 6: a dark-only colour token fails the pairing check', () => {
  const original = readFileSync(`${root}packages/ui/src/styles/1-tokens.css`, 'utf8');
  const darkOnly = original.replace(
    "[data-theme='dark'] {",
    "[data-theme='dark'] {\n  --sol-unpaired-colour: oklch(0.9 0 0);",
  );
  expect(darkOnly).not.toBe(original);

  const directory = mkdtempSync(join(tmpdir(), 'sol-mp-1-1-'));
  try {
    const css = join(directory, 'dark-only.css');
    writeFileSync(css, darkOnly);
    const result = spawnSync(process.execPath, [`${root}scripts/token-diff.mjs`, '--css', css], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('dark --sol-unpaired-colour');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
