// SPDX-License-Identifier: AGPL-3.0-only
// Types for scripts/db-shards.mjs, read by tests/ci/db-shards.test.ts.
export function parseShard(text: string): { index: number; count: number };
export function readTimings(path: string | URL): Record<string, number>;
export function assignShards(
  named: readonly string[],
  timings: Readonly<Record<string, number>>,
  count: number,
): string[][];
