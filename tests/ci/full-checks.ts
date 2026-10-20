// SPDX-License-Identifier: AGPL-3.0-only
//
// Queue hygiene (owner, 12 October 2026): ci.yml's `full checks` job runs unless the gate's scope
// is `light` (scripts/full-run.ts), and the heavy jobs wait on it. The scope is never light on a
// merge group (tests/ci/full-run.test.ts), so this exact condition skips no group; the tests that
// pin each job's condition accept it on that job alone.

/** The `full checks` job's own condition, exactly. */
export const FULL_GUARD = "needs.gate.outputs.scope != 'light'";

/** The jobs that wait on `full checks`: every heavy job, and none of the light ones. */
export const HEAVY: readonly string[] = [
  'check',
  'database-shard',
  'isolation',
  'parity',
  'visual-drift',
];
