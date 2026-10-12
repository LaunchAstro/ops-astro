// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error -- the header check is a plain JavaScript module
import { headerErrors } from '../../scripts/spdx-check.mjs';

it('JavaScript decrement code cannot hide a licence marker in a string', () => {
  const root = mkdtempSync(join(tmpdir(), 'spdx-decrement-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const file = join(root, 'unlicensed.mjs');
    writeFileSync(
      file,
      '--globalThis.counter; const note = `\n// SPDX-License-Identifier: AGPL-3.0-only\n`;\nexport default note;\n',
    );
    execFileSync(process.execPath, ['--check', file]);
    expect(headerErrors(root)).toContain('unlicensed.mjs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
