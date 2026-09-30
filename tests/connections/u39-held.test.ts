// SPDX-License-Identifier: AGPL-3.0-only
//
// U39's two cost tickets: the screen halves, held (BUILD-AHEAD-B3 rule 2). The
// data halves are `tests/costs/mp-14-9-skill-costs.test.ts` and
// `tests/costs/mp-14-6-agent-costs.test.ts`. Skill costing's screen sits on
// Connections & signal; What our agents cost us waits on the page kit
// (MP-9-1); the width-and-theme captures wait on MP-1-7. Each case is written
// in full, red first, once its dependency is on the branch.

import { describe, it } from 'vitest';

describe('MP-14-9 skill costing, the screen', () => {
  it.todo(
    'MP-14-9 owner check: skill costing shows each skill’s cost, and its process document link is drawn unavailable with its reason until Docs exists',
  );
  it.todo('MP-14-9 section numbers read top to bottom; skill costing is 009 (R61)');
  it.todo('MP-14-9 harness captures at 1480, 900 and 390, light and dark (MP-1-7)');
});

describe('MP-14-6 what our agents cost us, the screen, held on MP-9-1', () => {
  it.todo('MP-14-6 owner check: spend per agent and per client shows for the period');
  it.todo('MP-14-6 exact model ids wrap and never truncate');
  it.todo('MP-14-6 the cost log folds at 8 rows with "Show n more", as the book does (CS-14.10)');
  it.todo('MP-14-6 harness captures at 1480, 900 and 390, light and dark (MP-1-7)');
});
