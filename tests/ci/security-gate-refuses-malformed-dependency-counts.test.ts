// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');

it('malformed dependency counts cannot be approved as complete audits', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'proof-audit-'));
  try {
    const report = join(scratch, 'report.json');
    const exceptions = join(scratch, 'exceptions.json');
    writeFileSync(exceptions, JSON.stringify({ audit: [], semgrep: [] }));
    const run = (count: unknown) => {
      writeFileSync(
        report,
        JSON.stringify({ advisories: {}, metadata: { totalDependencies: count } }),
      );
      return spawnSync('node', [
        join(root, 'scripts/security-gate.mjs'),
        'audit',
        '--report',
        report,
        '--exceptions',
        exceptions,
        '--root',
        scratch,
      ]).status;
    };
    expect(run(1)).toBe(0);
    expect([run([1]), run(true), run('1'), run(0.5)]).toEqual([1, 1, 1, 1]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
