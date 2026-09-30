// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    globalSetup: ['tests/support/global-setup.ts', 'tests/support/temp-guard.ts'],
    setupFiles: ['tests/support/fixture-template-race-hook.mjs'],
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
