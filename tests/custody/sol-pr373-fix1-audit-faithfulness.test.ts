// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('Sol proof, criterion 7: the named custody audit-chain test must fail when its stored hashes are wrong', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sol-pr-373-fix1-audit-'));
  const reportPath = join(directory, 'report.json');
  try {
    const child = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        'tests/custody/sol-pr373-fix1-audit-mutation.test.ts',
        '-t',
        'C31 every change is recorded and joins the audit chain',
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${reportPath}`,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(child.error, child.stderr).toBeUndefined();
    const count = /Sol audit mutation count: (\d+)/u.exec(child.stdout)?.[1];
    expect(Number(count), 'the child must have broken a real stored audit chain').toBeGreaterThan(
      0,
    );
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      testResults: readonly {
        assertionResults: readonly { title: string; status: string }[];
      }[];
    };
    const named = report.testResults
      .flatMap((file) => file.assertionResults)
      .filter((test) => test.title === 'C31 every change is recorded and joins the audit chain');
    expect(named).toHaveLength(1);
    expect(named[0]?.status, 'the named proof accepted corrupted audit hashes').toBe('failed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
