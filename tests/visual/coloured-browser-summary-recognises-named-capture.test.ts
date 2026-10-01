// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const vitest = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));

it('a coloured browser summary recognises the named capture without a browser', () => {
  const run = spawnSync(
    process.execPath,
    [vitest, 'run', 'tests/visual/browser-proof-coloured-summary.test.ts'],
    { cwd: root, encoding: 'utf8' },
  );
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
});
