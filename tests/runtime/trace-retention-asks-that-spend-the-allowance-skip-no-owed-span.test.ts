// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention: the store answers four reads a pass and 429 after. Run R
// is owed with ten spans sent since its place, and the fifth newest is
// missing. The first pass reads the four newest. Before the second, four runs
// fall due, and their deletes are read back too. The owed read-back goes
// first and every read of the pass is counted together, so the second pass
// reads R's missing span and hears it is gone. Read after the asks, or judged
// by its own reads alone, R's read would move on past that span unheard.

import { expect, it } from 'vitest';
import { append, eventIds } from './aw-13-retention-world.ts';
import { queuedAsk } from './aw-13-race-world.ts';
import { awaitDue, drain, noDatabase, t, useAw13World } from './aw-13-world.ts';
import { dueRuns, pass, spanOf, traceOf, watched } from './trace-retention-pass-world.ts';

useAw13World('trret_asks_spend_allowance');

it.skipIf(noDatabase)(
  'Trace retention: asks that spend the store’s allowance skip no owed span',
  async () => {
    const s = t.alpha;
    const [runId = ''] = await dueRuns(s, 'trace retention asks spend allowance', 1);
    await queuedAsk(s);
    await append(runId, 10);
    await awaitDue(s);
    await drain(s);
    const newest = (await eventIds(runId)).slice(-10).toReversed();
    const missing = spanOf(s, newest[4] ?? '');
    t.target.spans.get(traceOf(s, runId))?.delete(missing);

    const { ports, seen } = watched();
    try {
      t.target.allowance = 4;
      await pass(s, ports);
      await dueRuns(s, 'trace retention asks spend allowance ask', 4);
      t.target.allowance = 4;
      await pass(s, ports);
    } finally {
      t.target.allowance = undefined;
    }
    expect(
      seen.filter((read) => read.span === missing).map((read) => read.answer),
      'the missing span is read, and answers gone, within two passes',
    ).toContain('absent');
  },
);
