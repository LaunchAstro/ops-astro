// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { expect, it } from 'vitest';
import { noDatabase } from './aw-06-world.ts';

/** The committed race test `suite`, its reader lock removed, its rival started `delay` ms late. */
function mutant(suite: string, delay: string): SpawnSyncReturns<string> {
  return spawnSync(
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
        RACE_MUTANT_RIVAL_DELAY: delay,
      },
      encoding: 'utf8',
      timeout: 90_000,
    },
  );
}

it.skipIf(noDatabase).each(['launch', 'four-eyes'])(
  '%s first-install race test rejects a missing reader lock when the rival starts late',
  (suite) => {
    const control = mutant(suite, '0');
    expect(control.error).toBeUndefined();
    expect(
      control.stdout + control.stderr,
      'the mutation must be detected with an immediate rival',
    ).toMatch(/Tests\s+1 failed/u);
    expect(control.status).toBe(1);
    const child = mutant(suite, '6000');
    expect(child.error).toBeUndefined();
    const output = child.stdout + child.stderr;
    expect(output, 'the committed race test must run against the real database').toMatch(
      /Tests\s+1 (?:passed|failed)/u,
    );
    expect(
      child.status,
      'the missing reader lock must make the claimed race proof fail; output:\n' + output,
    ).not.toBe(0);
  },
  100_000,
);
