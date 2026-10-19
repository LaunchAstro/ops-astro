// SPDX-License-Identifier: AGPL-3.0-only
//
// The confined A6 suite's own run (agent-egress-conformance.sh): the
// `*.confined.ts` files the default config's include never matches, one
// worker, and a cache in the temp folder, since the dropped uid can write
// nothing in the checkout.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  cacheDir: join(tmpdir(), 'agent-egress-vitest'),
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/harness/**/*.confined.ts'],
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
