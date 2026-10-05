// SPDX-License-Identifier: AGPL-3.0-only
import type { ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = {
  test: {
    environment: 'node',
    globals: false,
    globalSetup: [
      'tests/support/ci-must-run.ts',
      'tests/support/global-setup.ts',
      'tests/support/temp-guard.ts',
    ],
    setupFiles: ['tests/support/capture-chain-timeout.ts'],
    hookTimeout: 180_000,
    testTimeout: 30_000,
    maxWorkers: 1,
    include: ['tests/runtime/first-install-race-mutant.fixture.ts'],
  },
};

export default config;
