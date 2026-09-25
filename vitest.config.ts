// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Creates the cluster-wide roles once, before any file builds its own
    // database, so files starting side by side on a new cluster do not race
    // on `pg_authid_rolname_index` (see the file).
    globalSetup: ['tests/support/global-setup.ts'],
    // Hooks are where every database-bound file migrates a fresh database from
    // empty (`beforeAll`) and drops it (`afterAll`). That is legitimately slow
    // work, and with many files and other runs sharing the machine it ran past
    // the 10 s default while passing alone. Tests keep the 5 s default; the few
    // slow ones name their own timeout.
    hookTimeout: 60_000,
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      'packages/**/*.test.ts',
      'apps/**/*.test.ts',
    ],
  },
});
