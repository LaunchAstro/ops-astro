// SPDX-License-Identifier: AGPL-3.0-only
//
// U39's two cost tickets: the screen halves, held (BUILD-AHEAD-B3 rule 2). The
// data halves are `tests/costs/mp-14-9-skill-costs.test.ts` and
// `tests/costs/mp-14-6-agent-costs.test.ts`; skill costing's screen is
// `tests/surfaces/mp-14-9-costing-screen.test.tsx` and its captures are
// `tests/visual/sl13-harness-captures.test.ts`. What our agents cost us waits on
// the page kit (MP-9-1). Each case is written in full, red first, once its
// dependency is on the branch.

import { describe, it } from 'vitest';

describe('MP-14-6 what our agents cost us, the screen, held on MP-9-1', () => {
  it.todo('MP-14-6 owner check: spend per agent and per client shows for the period');
  it.todo('MP-14-6 exact model ids wrap and never truncate');
  it.todo('MP-14-6 the cost log folds at 8 rows with "Show n more", as the book does (CS-14.10)');
  it.todo('MP-14-6 harness captures at 1480, 900 and 390, light and dark (MP-1-7)');
});
