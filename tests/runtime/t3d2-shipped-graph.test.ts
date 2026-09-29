// SPDX-License-Identifier: AGPL-3.0-only
//
// `T3 shipped graph` for T3d2's crash seam. The seam is the parking worker's
// wrapped transport (`tests/support/parking-worker.ts`): it stops the process
// with SIGSTOP at a named point. No shipped source names that file, its
// setting or the signal, so no build of `apps/` or `packages/` can park; the
// test build does, as its own negative case. The cruiser's "nothing shippable
// imports tests/" rule is the other, independent barrier.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SEAM = /parking-worker|PARK_AT|SIGSTOP/u;

function sources(directory: string): string[] {
  return readdirSync(join(ROOT, directory), { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.(?:tsx?|mjs|js)$/u.test(path) && !path.includes('node_modules'))
    .map((path) => join(directory, path));
}

describe('T3 shipped graph: the crash seam', () => {
  it('no shipped source names the parking worker, its setting or SIGSTOP', () => {
    const named = ['apps', 'packages']
      .flatMap(sources)
      .filter((file) => SEAM.test(readFileSync(join(ROOT, file), 'utf8')));
    expect(named).toStrictEqual([]);
  });

  it('the test build does: its own negative case', () => {
    const harness = readFileSync(join(ROOT, 'tests/acceptance/kill-harness.ts'), 'utf8');
    expect(harness).toContain("'tests/support/parking-worker.ts'");
    const seam = readFileSync(join(ROOT, 'tests/support/parking-worker.ts'), 'utf8');
    expect(seam).toMatch(/process\.kill\(process\.pid, 'SIGSTOP'\)/u);
  });
});
