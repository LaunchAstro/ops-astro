// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(
  process.env['DATABASE_URL'] === undefined || process.env['DATABASE_ADMIN_URL'] === undefined,
)(
  'the named service-stop proof passes with the documented two database URLs',
  () => {
    const statuses = Array.from({ length: 3 }, () => {
      const run = spawnSync(
        process.execPath,
        ['node_modules/vitest/vitest.mjs', 'run', 'tests/ci/named-service-stop-reaches-database.test.ts'],
        {
          cwd: join(import.meta.dirname, '../..'),
          encoding: 'utf8',
          env: { ...process.env },
        },
      );
      return run.status;
    });
    expect(statuses).toStrictEqual([0, 0, 0]);
  },
  60_000,
);
