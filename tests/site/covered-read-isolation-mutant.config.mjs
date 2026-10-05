// SPDX-License-Identifier: AGPL-3.0-only
export default {
  test: {
    include: ['tests/site/covered-read-isolation-mutant.ts'],
    environment: 'node',
    maxWorkers: 1,
    globalSetup: ['tests/support/global-setup.ts', 'tests/support/temp-guard.ts'],
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
};
