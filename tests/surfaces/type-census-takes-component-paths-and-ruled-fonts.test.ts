// SPDX-License-Identifier: AGPL-3.0-only
//
// The type census scans a component file named with --tsx even when no sheet
// is named, and accepts a literal font whose rule carries a ruling marker,
// listing it as an exception, as it does any other ruled override.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const scratch = mkdtempSync(join(tmpdir(), 'type-census-options-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const census = (...args: string[]) =>
  spawnSync(process.execPath, ['scripts/type-census.mjs', ...args], { encoding: 'utf8' });

it('scans a component file named alone, with no sheet named', () => {
  const file = join(scratch, 'inline.tsx');
  writeFileSync(file, 'export const C = () => <p style={{ fontSize: 99 }} />;\n');
  const out = census('--tsx', file);
  expect(out.status, 'the named component file was never read').toBe(1);
  expect(out.stderr).toContain('inline.tsx: text styled inline (fontSize)');
});

it('lists a ruled literal font as an exception and accepts it', () => {
  const sheet = join(scratch, 'ruled.css');
  writeFileSync(
    sheet,
    ".y {\n  /* type-exception DR-6: the run hero's mono 20 number */\n  font: 500 20px monospace;\n}\n",
  );
  const out = census('--css', sheet, '--json');
  const result = JSON.parse(out.stdout) as {
    exceptions: { selector: string; ruling: string; overrides: string[] }[];
  };
  expect(result.exceptions).toEqual([
    expect.objectContaining({
      selector: '.y',
      ruling: 'DR-6',
      overrides: ['font: 500 20px monospace'],
    }),
  ]);
  expect(out.stderr, 'the ruled font was listed and refused at once').toBe('');
  expect(out.status).toBe(0);
});
