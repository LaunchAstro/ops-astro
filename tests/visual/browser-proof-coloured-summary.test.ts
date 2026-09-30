// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const vitest = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));

it('MP-1-1 the browser-dependency proof accepts a coloured test summary', () => {
  // The capture run is real, with colour forced. With CI set the wrapper has
  // no skip path (no browser fails it), and its file holds one test, so a zero
  // exit means the wrapper ran and passed: the named capture passed.
  const run = spawnSync(
    process.execPath,
    [vitest, 'run', 'tests/visual/harness-capture-needs-browser.test.ts'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1', FORCE_COLOR: '1' } },
  );
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
});
