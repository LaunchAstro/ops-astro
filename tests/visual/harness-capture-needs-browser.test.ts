// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const vitest = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));

it('MP-1-1 the named page capture requires a browser screenshot', () => {
  // The child's own temp folder: what Playwright leaves when it cannot launch
  // is removed with it, so the parent's temp guard sees nothing.
  const temp = mkdtempSync(join(tmpdir(), 'no-browser-'));
  const run = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      'tests/surfaces/mp-1-1-tokens.test.tsx',
      '--testNamePattern',
      'MP-1-1 harness captures',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: join(tmpdir(), `sol-no-browser-${randomUUID()}`),
        TMPDIR: temp,
      },
    },
  );
  rmSync(temp, { recursive: true, force: true });
  // Vitest colours its summary when the terminal allows; the count is read without the codes.
  const output = stripVTControlCharacters(`${run.stdout}\n${run.stderr}`);
  expect(output).toMatch(/Tests\s+1 (passed|failed)/u);
  expect(run.status, 'the named capture test passed with no browser available').not.toBe(0);
});
