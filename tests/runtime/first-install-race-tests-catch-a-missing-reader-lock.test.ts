// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.each(['launch', 'four-eyes'])(
  '%s first-install race test rejects a missing reader lock when the rival starts late',
  (suite) => {
    const control = spawnSync(
      'corepack',
      [
        'pnpm',
        'exec',
        'vitest',
        'run',
        '--config',
        'tests/runtime/first-install-race-mutant.config.ts',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NO_COLOR: '1',
          RACE_MUTANT_SUITE: suite,
          RACE_MUTANT_RIVAL_DELAY: '0',
        },
        encoding: 'utf8',
        timeout: 90_000,
      },
    );
    expect(control.error).toBeUndefined();
    expect(
      control.stdout + control.stderr,
      'the mutation must be detected with an immediate rival',
    ).toMatch(/Tests\s+1 failed/);
    expect(control.status).toBe(1);
    const child = spawnSync(
      'corepack',
      [
        'pnpm',
        'exec',
        'vitest',
        'run',
        '--config',
        'tests/runtime/first-install-race-mutant.config.ts',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NO_COLOR: '1',
          RACE_MUTANT_SUITE: suite,
          RACE_MUTANT_RIVAL_DELAY: '6000',
        },
        encoding: 'utf8',
        timeout: 90_000,
      },
    );
    expect(child.error).toBeUndefined();
    const output = child.stdout + child.stderr;
    expect(output, 'the committed race test must run against the real database').toMatch(
      /Tests\s+1 (?:passed|failed)/,
    );
    expect(
      child.status,
      'the missing reader lock must make the claimed race proof fail; output:\n' + output,
    ).not.toBe(0);
  },
  100_000,
);
