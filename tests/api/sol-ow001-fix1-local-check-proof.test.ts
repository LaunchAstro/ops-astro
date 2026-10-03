// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('Sol proof, criterion correctness: database-free local checks can run the OW-001 proof files', () => {
  const environment = { ...process.env };
  delete environment['DATABASE_URL'];
  delete environment['DATABASE_ADMIN_URL'];
  // The local-check job has no database. Excluding these files there is valid;
  // their three behavioural assertions must still run in database conformance.
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--passWithNoTests',
      'tests/api/sol-ow001-session-proof.test.ts',
      'tests/api/sol-ow001-quota-proof.test.ts',
    ],
    { env: environment, encoding: 'utf8', timeout: 30_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
