// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error -- the checker is JavaScript
import { headerErrors } from '../../scripts/spdx-check.mjs';

it('code between block comments cannot turn a string marker into a licence header', () => {
  const root = mkdtempSync(join(tmpdir(), 'spdx-between-blocks-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const file = join(root, 'unlicensed.mjs');
    writeFileSync(
      file,
      '/* comment */ const note = `/* literal */\n// SPDX-License-Identifier: AGPL-3.0-only\n`;\nexport default note;\n',
    );
    execFileSync(process.execPath, ['--check', file]);
    expect(headerErrors(root)).toContain('unlicensed.mjs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
