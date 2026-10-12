// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention: a pass whose budget is spent reads nothing more, and a run
// it did not reach is not recorded as read. With a budget of one read, the
// first pass reads owed run X only; Y keeps its turn, ahead of X, and the
// next pass reads Y first, from where Y's reading stood.

import { expect, it } from 'vitest';
import { passBudget } from '../../packages/core-runtime/src/trace-store.ts';
import { noDatabase, t, useAw13World } from './aw-13-world.ts';
import {
  lastEvent,
  owedRuns,
  pass,
  spanOf,
  traceOf,
  watched,
} from './trace-retention-pass-world.ts';

useAw13World('trret_budget_not_reached');

it.skipIf(noDatabase)(
  'Trace retention: a run the budget did not reach keeps its turn and place',
  async () => {
    const s = t.alpha;
    const [x = '', y = ''] = await owedRuns(s, 'trace retention budget not reached', 2);

    const first = watched();
    await pass(s, first.ports, { budget: passBudget(1) });
    expect(
      first.seen.map((read) => read.trace),
      'one read, the first run in turn order',
    ).toEqual([traceOf(s, x)]);

    const next = watched();
    await pass(s, next.ports, { budget: passBudget(1) });
    expect(
      next.seen.map((read) => [read.trace, read.span]),
      'the run not reached goes first, from its place',
    ).toEqual([[traceOf(s, y), spanOf(s, await lastEvent(s, y))]]);
  },
);
