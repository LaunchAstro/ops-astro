// SPDX-License-Identifier: AGPL-3.0-only
import { configDefaults, defineConfig } from 'vitest/config';

// With a database, the database-bound suites run, and every one migrates a
// fresh database from empty in one transaction. Migration 0008 comments on a
// cluster-wide role inside that transaction, so each file's migration waits
// for every other migration on the server to commit, this run's and any other
// run's sharing it. A loaded machine turned that queue into 5 s test timeouts
// and 60 s hook timeouts that passed alone (product issue 56). So a database
// run uses four workers, the hosted runner's cores, and times sized for the
// queue. Without a database those suites skip and the defaults stand.
const database = (process.env['DATABASE_URL'] ?? '') !== '';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // On CI with a database, fails the run if a proof that must run there
    // skipped (see the file); first, so its teardown runs after the others.
    // Creates the cluster-wide roles once, before any file builds its own
    // database, so files starting side by side on a new cluster do not race
    // on `pg_authid_rolname_index` (see the file).
    // Gives the run a temp folder of its own and fails the run if a test
    // leaves anything in it (issue #103, see the file).
    globalSetup: [
      'tests/support/ci-must-run.ts',
      'tests/support/global-setup.ts',
      'tests/support/temp-guard.ts',
    ],
    // Gives the browser-capture proof and the proofs that run it a longer
    // timeout, file by file (see the file). A second project would do it too,
    // but labels every `vitest list` line, which scripts/db-conformance.mjs
    // reads as paths.
    setupFiles: ['tests/support/capture-chain-timeout.ts'],
    // Hooks are where every database-bound file migrates a fresh database from
    // empty (`beforeAll`) and drops it (`afterAll`). That is legitimately slow
    // work, and with many files and other runs sharing the machine it ran past
    // the 10 s default while passing alone. The few slow tests name their own
    // timeout, and a hook or test naming its own keeps it.
    hookTimeout: database ? 180_000 : 60_000,
    testTimeout: database ? 30_000 : 5_000,
    ...(database ? { maxWorkers: 4 } : {}),
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      'packages/**/*.test.ts',
      'apps/**/*.test.ts',
    ],
    // Sol's leaked-client proof, kept byte for byte, opens its world with no skip; without a
    // database it is left out here, and the manifests run it where there is one.
    ...(database
      ? {}
      : {
          exclude: [
            ...configDefaults.exclude,
            'tests/api/leaked-client-read-isolation-assertion.test.ts',
          ],
        }),
  },
});
