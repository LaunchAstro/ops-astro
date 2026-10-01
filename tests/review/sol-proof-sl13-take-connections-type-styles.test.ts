// SPDX-License-Identifier: AGPL-3.0-only
//
// Opus interim review of SL13's take (75527ae..9c625d4), finding B1. Sits in
// tests/review/. Batch 1's MP-1-4 visual match came in with the take
// (5362fd2); SL13's own Connections page (agency:connections) draws its h1,
// its section h2s and the skill-costing title in no declared type style.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

it('Sol proof, criterion correctness: the merged Connections page draws every text in one of the 23 type styles (MP-1-4 visual match)', () => {
  const run = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', 'tests/surfaces/mp-1-4-type-scale.test.ts', '-t', 'visual match'],
    { cwd: root, encoding: 'utf8' },
  );
  const out = `${run.stdout}\n${run.stderr}`;
  expect(out).not.toMatch(/agency:connections@\d+-(?:light|dark): text in no type style/u);
  expect(run.status, out).toBe(0);
}, 900_000);
