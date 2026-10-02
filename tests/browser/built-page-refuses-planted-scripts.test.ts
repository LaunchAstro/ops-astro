// SPDX-License-Identifier: AGPL-3.0-only
//
// The built page, in a real browser, runs its own bundle and none of the
// scripts planted in it: an inline script, an inline handler, an outside file.
//
// Reading the policy's text out of `index.html` shows what the page asks for;
// only a browser loading the built page shows that a planted script does not
// run. `content-policy.mjs` is that run. This case holds it to passing at the
// head, after `pnpm build:web`.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

describe('the built page refuses planted scripts in a real browser', () => {
  it('its own bundle runs and no planted inline, handler or outside script does', () => {
    const built = spawnSync('pnpm', ['build:web'], { cwd: ROOT, encoding: 'utf8', timeout: 240_000 });
    expect(built.status, built.stderr).toBe(0);
    const run = spawnSync(process.execPath, ['tests/browser/content-policy.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(run.stdout + run.stderr).not.toMatch(/FAIL|Error/u);
    expect(run.status).toBe(0);
  }, 320_000);
});
