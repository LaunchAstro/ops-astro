// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('review proofs retain the saved patch bytes', () => {
  const patchBlobs = new Map([
    ['tests/ci/fixture-database-url-container-proof.test.ts', '326f6957067ec306a452fe825bca2339a621e53d'],
    ['tests/ci/fixture-template-ownership-proof.test.ts', '4181edff1835ae6e9aca815ca3d66c9e153cfe43'],
    ['tests/ci/isolation-manifest-fixture-suites-proof.test.ts', '0803e5f382046dea305818d4ee663f693042ddc6'],
    ['tests/ci/moved-snapshot-proof-argv-path.test.ts', 'ae403c33e19f6b5ca1b0ae1736e0055b7ba5ffdf'],
    ['tests/support/fixture-race-vitest.config.mjs', '7661856095dbb35356fcff95c1f9f6b566b09e70'],
    ['tests/support/fixture-template-race-hook.mjs', '50b532bfc8470519efac2604d8494b2a4c732648'],
  ]);
  const changed = [...patchBlobs].filter(([path, expected]) =>
    execFileSync('git', ['hash-object', path], { encoding: 'utf8' }).trim() !== expected,
  );
  expect(changed).toStrictEqual([]);
});
