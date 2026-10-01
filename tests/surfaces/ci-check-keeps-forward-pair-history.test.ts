// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('MP-1-2 the required check keeps the history the forward-pair proof reads', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const start = workflow.indexOf('\n  check:\n');
  const end = workflow.indexOf('\n  database-gate:', start);
  const checkJob = workflow.slice(start, end);
  expect(checkJob).toContain('run: pnpm check');
  const checkout = checkJob.split('- uses: actions/checkout@')[1]?.split('\n      - ')[0] ?? '';
  const proof = readFileSync(
    join(root, 'tests/surfaces/fonts-forward-pair-and-production-woff2.test.ts'),
    'utf8',
  );
  const anchor = /const anchor = '([0-9a-f]{40})'/u.exec(proof)?.[1];
  expect(anchor, 'the forward-pair proof names its anchor').toBeDefined();

  const scratch = mkdtempSync(join(tmpdir(), 'mp-1-2-checkout-'));
  try {
    const clone = spawnSync(
      'git',
      [
        'clone',
        '--quiet',
        '--no-local',
        ...(/fetch-depth:\s*0/u.test(checkout) ? [] : ['--depth=1']),
        pathToFileURL(root).href,
        join(scratch, 'repo'),
      ],
      { encoding: 'utf8' },
    );
    expect(clone.status, clone.stderr).toBe(0);
    const history = spawnSync(
      'git',
      ['-C', join(scratch, 'repo'), 'rev-list', '--ancestry-path', `${anchor}..HEAD`],
      { encoding: 'utf8' },
    );
    expect(history.status, history.stderr).toBe(0);
    expect(history.stdout.trim(), 'the anchor is an ancestor below HEAD').not.toBe('');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
