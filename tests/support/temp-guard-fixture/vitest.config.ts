// SPDX-License-Identifier: AGPL-3.0-only
//
// A run of its own for `temp-guard.test.ts`: the temp guard alone, over the
// fixture files here, which the repository's own run never includes.
import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  test: {
    root: import.meta.dirname,
    environment: 'node',
    globalSetup: ['../temp-guard.ts'],
    include: ['*.fixture.ts'],
  },
});

export default config;
