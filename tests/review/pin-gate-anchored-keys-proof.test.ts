// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');

for (const [description, key] of [
  ['an anchored escaped key', '&action "us\\u0065s"'],
  ['an anchored tagged key', '&action !!str uses'],
]) {
  test(`the pin gate rejects an unpinned action behind ${description}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'sol-1365-pins-'));
    try {
      for (const path of ['scripts', '.github/workflows', 'docs'])
        mkdirSync(join(dir, path), { recursive: true });
      copyFileSync(join(root, 'scripts/pins-check.mjs'), join(dir, 'scripts/pins-check.mjs'));
      writeFileSync(join(dir, 'docs/supply-chain-pins.md'), 'no pins\n');
      const workflow = `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - ${key}: actions/checkout@v4\n`;
      assert.equal(parse(workflow).jobs.a.steps[0].uses, 'actions/checkout@v4');
      writeFileSync(join(dir, '.github/workflows/ci.yml'), workflow);
      const run = spawnSync(process.execPath, [join(dir, 'scripts/pins-check.mjs')], {
        encoding: 'utf8',
      });
      assert.equal(run.status, 1, run.stdout + run.stderr);
      // The pin check's own refusal, not a checker that failed to load.
      assert.match(run.stderr, /actions\/checkout@v4 is not pinned to a 40 character commit hash/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
