// SPDX-License-Identifier: AGPL-3.0-only
//
// Opus interim review of SL13's take (75527ae..9c625d4), finding B2. Sits in
// tests/review/. Batch 1's MP-1-7 harness came in with the take (5362fd2) and
// pins the pages built so far; SL13's agency:connections route is registered
// (routes.ts, resolved in 5362fd2) and the harness's pin and pictures do not
// carry it, so the required local check is red on the take's head.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { builtPages } from '../visual/report.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

it("MP-1-7's every-page check holds with SL13's Connections route registered", () => {
  expect(builtPages()).toContain('agency:connections');
  const run = spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      'tests/visual/mp-1-7-harness.test.ts',
      '-t',
      'every page built so far',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const out = `${run.stdout}\n${run.stderr}`;
  expect(out).not.toMatch(/\+\s+"agency:connections"/u);
  expect(run.status, out).toBe(0);
}, 300_000);
