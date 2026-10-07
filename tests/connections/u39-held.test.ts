// SPDX-License-Identifier: AGPL-3.0-only
//
// The two cost screens, held (BUILD-AHEAD-B3 rule 2). The
// data halves are `tests/costs/mp-14-9-skill-costs.test.ts` and
// `tests/costs/mp-14-6-agent-costs.test.ts`. Skill costing's screen sits on
// Connections & signal; What our agents cost us waits on the page kit
// (MP-9-1); the width-and-theme captures wait on MP-1-7. Each case is written
// in full, red first, once its dependency is on the branch.

import { describe, it } from 'vitest';

describe('skill costing, the screen', () => {
  it.todo(
    'owner check: skill costing shows each skill’s cost, and its process document link is drawn unavailable with its reason until Docs exists',
  );
  it.todo('section numbers read top to bottom; skill costing is 009 (R61)');
  it.todo('harness captures at 1480, 900 and 390, light and dark');
});

describe('what our agents cost us, the screen, held on the page kit', () => {
  it.todo('owner check: spend per agent and per client shows for the period');
  it.todo('exact model ids wrap and never truncate');
  it.todo('the cost log folds at 8 rows with "Show n more", as the book does (CS-14.10)');
  it.todo('harness captures at 1480, 900 and 390, light and dark');
});
