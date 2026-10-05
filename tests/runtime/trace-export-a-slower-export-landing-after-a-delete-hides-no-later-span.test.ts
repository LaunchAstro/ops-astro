// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace export (#475, #966 item 1): exports A and B read batch X (E151) while
// run R's delete is owed. A waits on the target; B, on its own connection,
// delivers X, then its next export D sends R's owed events with the later
// event Y (E152). The queued delete takes the trace. A's bodies then all
// land, restoring R's earlier events only. Every in-window span E1..E152 must
// end up held.

import { expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { Deliver, ExportOutcome } from '../../packages/core-runtime/src/index.ts';
import {
  derivedId,
  expireOnce,
  exportOnce,
  TRACE_WINDOW_DAYS,
} from '../../packages/core-runtime/src/index.ts';
import { liveWork } from './schedules-harness.ts';
import { age, append, eventIds } from './aw-13-retention-world.ts';
import { gate, queuedAsk } from './aw-13-race-world.ts';
import { awaitDue, drain, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trexp_slower_export');

it.skipIf(noDatabase)(
  'Trace export: a slower export whose bodies all land after a queued delete hides no later span',
  async () => {
    const s = t.alpha;
    const work = await liveWork(s, 'trace export slower export', 1_000);
    const runId = String(work.picked['runId']);
    const traceR = derivedId(TRACE_KEY, ['trace', s.business, runId], 32);
    const spanOf = (id: string): string => derivedId(TRACE_KEY, ['span', s.business, id], 16);
    await drain(s);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    const before = new Set(await eventIds(runId));

    const land = await queuedAsk(s);
    await append(runId, 150);
    await awaitDue(s);
    await drain(s);
    await append(runId, 1);
    await awaitDue(s);

    const paused = gate();
    const slow: Deliver = async (body) => {
      await paused.arrive();
      return await t.target.deliver(body);
    };
    const rival = connect(s.db.appUrl, { max: 1, source: 'trace-export-rival' });
    const a = exportOnce(s.db.app, s.business, TRACE_KEY, slow);
    const outcomes: ExportOutcome[] = [];
    try {
      await paused.reached;
      outcomes.push(await exportOnce(rival, s.business, TRACE_KEY, t.target.deliver));
      await append(runId, 1);
      await awaitDue(s);
      outcomes.push(await exportOnce(rival, s.business, TRACE_KEY, t.target.deliver));
      await land();
      expect(t.target.stored.has(traceR), 'the queued delete took the whole trace').toBe(false);
      paused.release();
      expect(await a).toMatchObject({ kind: 'delivered' });
    } finally {
      paused.release();
      await Promise.allSettled([a]);
      await rival.close();
    }
    const fresh = (await eventIds(runId)).filter((id) => !before.has(id));
    expect(fresh).toHaveLength(152);

    for (let round = 0; round < 3; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await expireOnce(s.db.app, s.business, TRACE_KEY, t.target.expiry);
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await drain(s);
    }
    const kept = t.target.spans.get(traceR) ?? new Set<string>();
    expect(
      fresh.filter((id) => !kept.has(spanOf(id))),
      'every in-window span E1..E152 is held',
    ).toEqual([]);
    expect(outcomes, 'B and D wait while A holds the business').toEqual([
      { kind: 'held' },
      { kind: 'held' },
    ]);
  },
);
