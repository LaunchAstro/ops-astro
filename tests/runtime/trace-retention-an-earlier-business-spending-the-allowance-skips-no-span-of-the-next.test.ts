// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention: one deployment pass visits every business through one
// custody and one store, and the store answers four reads a pass and 429
// after. Alpha's owed run has six spans that always answer present, so
// alpha's reads spend the allowance. Bravo's owed run has one span, and it is
// missing. Every read of the pass counts against one budget, and each pass
// starts one business further on, so bravo's run is read first within two
// passes and found gone. Judged by bravo's reads alone, it would move on
// unheard every pass.

import { expect, it } from 'vitest';
import { retainDeployment } from '../../apps/api/trace-exporter.ts';
import { append } from './aw-13-retention-world.ts';
import { queuedAsk } from './aw-13-race-world.ts';
import { awaitDue, drain, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';
import {
  dueRuns,
  lastEvent,
  owedRuns,
  spanOf,
  traceOf,
  watched,
} from './trace-retention-pass-world.ts';

useAw13World('trret_earlier_business');

const businesses = (): Promise<readonly string[]> =>
  Promise.resolve([t.alpha.business, t.bravo.business]);

it.skipIf(noDatabase)(
  'Trace retention: an earlier business spending the allowance skips no span of the next',
  async () => {
    const [alphaRun = ''] = await dueRuns(t.alpha, 'trace retention earlier business', 1);
    await queuedAsk(t.alpha);
    await append(alphaRun, 6);
    await awaitDue(t.alpha);
    await drain(t.alpha);
    const [bravoRun = ''] = await owedRuns(t.bravo, 'trace retention next business', 1);
    const missing = spanOf(t.bravo, await lastEvent(t.bravo, bravoRun));
    t.target.spans.get(traceOf(t.bravo, bravoRun))?.delete(missing);

    const { ports, seen } = watched();
    try {
      for (let round = 0; round < 2; round += 1) {
        t.target.allowance = 4;
        // eslint-disable-next-line no-await-in-loop -- one deployment pass after another
        await retainDeployment(t.alpha.db.app, businesses, TRACE_KEY, ports, round);
      }
    } finally {
      t.target.allowance = undefined;
    }
    expect(
      seen.filter((read) => read.span === missing).map((read) => read.answer),
      'bravo’s missing span is read, and answers gone, within two passes',
    ).toContain('absent');
  },
);
