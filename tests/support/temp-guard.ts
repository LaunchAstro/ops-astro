// SPDX-License-Identifier: AGPL-3.0-only
//
// Once per run: give the run a temp folder of its own, and fail the run if
// anything is left in it at the end.
//
// Leftover test folders filled the disk on 29 September 2026 (issue #103),
// which took Docker and the shared test database down with it. Several runs
// share one user temp folder, so this does not compare that folder before and
// after: a run beside this one would look like a leak. Instead TMPDIR points
// at a fresh folder for the whole run, which the workers and every process a
// test spawns inherit, so whatever is inside it at the end was made by this
// run. The folder is removed either way, so a leak fails the run without
// filling the disk.
//
// Vitest 5.0.0 leaks a folder of its own on every run: the module cache it
// makes under the temp folder before this setup runs (`_tmpDir`, next to its
// `clearTmpDir`, which removes only the per-project one). Nothing else removes
// it, so the teardown does.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

// Node's compile cache, which Corepack's `pnpm` shim turns on, lives in the
// temp folder by default. It is one shared cache, not a leftover, so it does
// not count; it is removed with the run's folder all the same.
const CACHES = new Set(['node-compile-cache']);

export default function setup(project: TestProject): () => void {
  const vitestCache: unknown = Reflect.get(project.vitest, '_tmpDir');
  const previous = process.env['TMPDIR'];
  const run = mkdtempSync(join(tmpdir(), 'ops-astro-test-run-'));
  process.env['TMPDIR'] = run;
  return () => {
    const left = readdirSync(run).filter((entry) => !CACHES.has(entry));
    rmSync(run, { recursive: true, force: true });
    if (typeof vitestCache === 'string') rmSync(vitestCache, { recursive: true, force: true });
    if (previous === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previous;
    if (left.length > 0) {
      const entries = left.length === 1 ? 'entry' : 'entries';
      throw new Error(
        `temp guard: this run left ${String(left.length)} ${entries} in the temp folder: ` +
          `${left.join(', ')}. Remove each in afterEach, afterAll or a finally.`,
      );
    }
  };
}
