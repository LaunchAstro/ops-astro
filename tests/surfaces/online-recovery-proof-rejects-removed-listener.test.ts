// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

function check(config?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'sol-f1-online-'));
  const output = join(directory, 'result.json');
  try {
    const child = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        'tests/surfaces/live-read-unavailable-first-recovers.test.tsx',
        '--reporter=json',
        '--outputFile',
        output,
        ...(config === undefined ? [] : ['--config', config]),
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(child.error).toBeUndefined();
    const report = JSON.parse(readFileSync(output, 'utf8')) as {
      numPassedTests: number;
      numTotalTests: number;
    };
    return { ...child, report };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Sol F1-FIX1 criterion 7, retitled by what it proves; its body is Sol's.
it('the named online-recovery proof rejects removal of its online listener', () => {
  const control = check();
  expect(control.status, control.stderr).toBe(0);
  expect(control.report.numPassedTests).toBe(1);
  // The named test remains unchanged; only every actual online subscription
  // is disabled. The setup proves it intercepted a subscription.
  const mutant = check('tests/surfaces/online-listener-removed.config.ts');
  expect(mutant.report.numTotalTests).toBeGreaterThan(0);
  expect(
    mutant.status,
    'The test claims online recovery but stays green with every online listener removed.',
  ).not.toBe(0);
}, 120_000);
