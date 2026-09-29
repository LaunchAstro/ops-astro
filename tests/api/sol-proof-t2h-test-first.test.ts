// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('T2h test-first history', () => {
  it('Sol proof, criterion 2: the API invariant was committed before its implementation', () => {
    const implementation = execFileSync(
      'git',
      ['log', '-1', '--format=%H', '--diff-filter=A', '--', 'migrations/0036_alerts.sql'],
      { encoding: 'utf8' },
    ).trim();
    expect(implementation).not.toBe('');

    const prior = spawnSync(
      'git',
      ['cat-file', '-e', `${implementation}^:tests/api/t2h-alerts-surfaces.test.ts`],
      { encoding: 'utf8' },
    );
    expect(
      prior.status,
      'the API invariant must exist on the red commit before migration 0036',
    ).toBe(0);
  });
});
