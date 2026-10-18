// SPDX-License-Identifier: AGPL-3.0-only
//
// Review proof: the tag isolation suite's client crossing runs to its end,
// rather than stopping in its own setup before either client is linked.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('the tag isolation suite', () => {
  it('reaches its client crossing', () => {
    const run = spawnSync(
      './node_modules/.bin/vitest',
      [
        'run',
        'tests/commands/task-tags-isolation.test.ts',
        '-t',
        'a client A editor tags client A',
      ],
      { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 120_000 },
    );
    expect(run.error, 'the test runner must start').toBeUndefined();
    expect(run.status, run.stdout + run.stderr).toBe(0);
  }, 150_000);
});
