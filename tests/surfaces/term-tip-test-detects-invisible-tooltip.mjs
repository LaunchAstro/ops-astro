// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { chromium } from 'playwright';

// Sol OW-131 criterion 7, retitled by what it proves; its body is Sol's.
test('the named hover and keyboard tooltip test detects an invisible tooltip', async () => {
  // Run only in a disposable source copy, as this fault injection changes a dependency temporarily.
  assert.equal(process.env.SOL_THROWAWAY, '1');
  const path = 'packages/ui/src/styles/2-controls-and-marks.css';
  const original = readFileSync(path, 'utf8');
  const mutant = original.replace(
    /\.term:hover \.term__tip,\s*\.term:focus-visible \.term__tip\s*\{[^}]*\}/u,
    '',
  );
  assert.notEqual(mutant, original, 'the visibility rule must be removed');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<style>${mutant}</style><span class="term" tabindex="0">Hours<span class="term__tip" role="tooltip">Tracked time</span></span>`,
    );
    await page.locator('.term').hover();
    assert.equal(await page.locator('.term__tip').isVisible(), false);
    await page.locator('.term').focus();
    assert.equal(await page.locator('.term__tip').isVisible(), false);
    writeFileSync(path, mutant);
    const run = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        'tests/surfaces/mp-9-1-page-kit.test.tsx',
        '-t',
        'a term tip shows its definition on hover and on keyboard focus',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(run.error, undefined);
    const output = (run.stdout + run.stderr).replace(/\x1b\[[0-9;]*m/gu, '');
    if (run.status === 0)
      assert.match(output, /Tests\s+1 passed/u, 'the selected test must execute');
    assert.notEqual(
      run.status,
      0,
      'the named tooltip proof passed with the tooltip invisible on both hover and focus',
    );
    assert.match(output, /Tests\s+1 failed/u, 'the selected test must fail, rather than its setup');
    assert.match(output, /FAIL[^\n]*a term tip shows its definition/u);
  } finally {
    writeFileSync(path, original);
    await browser.close();
  }
});
