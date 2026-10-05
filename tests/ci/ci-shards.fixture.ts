// SPDX-License-Identifier: AGPL-3.0-only
// What tests/ci/ci-shards-*.test.ts share: the shard counts ci.yml runs, the
// plan, the workflow as GitHub reads it, and a check that a split holds every
// entry once.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { parseDocument } from 'yaml';
import { isolationItems, readShardPlan, type ShardPlan } from '../../scripts/ci-shards.ts';
import { read, ROOT } from './merge-group-repo.ts';

// CI-SHARDS-2, measured: each shard finishes inside the database shards' window
// (tests/ci/ci-shard-plan.json, and the pull request that set these).
export const LOCAL_COUNT = 3;
export const ISOLATION_COUNT = 2;

/** The matrix value ci.yml hands each shard's runner. */
export const SHARD = '${{ matrix.shard }}/${{ strategy.job-total }}';

export type Step = { name?: string; run?: string; env?: Record<string, string> };
export type Job = {
  name?: string;
  if?: string;
  needs?: string[];
  strategy?: { 'fail-fast'?: boolean; matrix?: { shard?: number[] } };
  'continue-on-error'?: unknown;
  steps?: Step[];
};

export const ci = parseDocument(read('.github/workflows/ci.yml'), { uniqueKeys: true }).toJS() as {
  jobs: Record<string, Job>;
};
export const plan: ShardPlan = readShardPlan(ROOT);
export const items: string[] = isolationItems(ROOT);

/** A scratch directory each test file removes when it ends. */
export function scratch(): () => string {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  return () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-shards-'));
    dirs.push(dir);
    return dir;
  };
}

/** Each entry of `lists` in exactly one list, and the lists together exactly `all`. */
export function partitionProblems(
  lists: readonly (readonly string[])[],
  all: readonly string[],
): string[] {
  const seen = new Map<string, number>();
  const problems: string[] = [];
  lists.forEach((list, i) => {
    if (list.length === 0) problems.push(`shard ${String(i + 1)} is empty`);
    for (const entry of list) {
      const before = seen.get(entry);
      if (before !== undefined)
        problems.push(`${entry} in shards ${String(before)} and ${String(i + 1)}`);
      seen.set(entry, i + 1);
    }
  });
  for (const entry of all) if (!seen.has(entry)) problems.push(`${entry} in no shard`);
  for (const entry of seen.keys()) if (!all.includes(entry)) problems.push(`${entry} is extra`);
  return problems;
}

/** The heaviest shard's load, and the most it may carry: a tenth over its share, or the one item too long to share. */
export function balance(
  shards: readonly (readonly string[])[],
  weight: (item: string) => number,
): { heaviest: number; bound: number } {
  const loads = shards.map((s) => s.reduce((sum, item) => sum + weight(item), 0));
  const total = loads.reduce((a, b) => a + b, 0);
  const longest = Math.max(...shards.flat().map((item) => weight(item)));
  return { heaviest: Math.max(...loads), bound: Math.max(longest, (total / shards.length) * 1.1) };
}
