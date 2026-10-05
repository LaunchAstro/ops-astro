// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace export (#963, Sol PRV-oa-963-R1.1): export A reads batch X (E151)
// while run R's delete is owed, renews its lease for its first body, and
// stalls before sending it. Its lease expires; B, on its own connection,
// delivers X, then D delivers Y (E152). The queued delete takes the trace.
// A wakes and sends its stale first body (E1..E100), then finds its lease
// gone. Retention and export, with nothing new, must bring back every
// in-window span E1..E152.

import { expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import {
  derivedId,
  expireOnce,
  exportOnce,
  TRACE_WINDOW_DAYS,
} from '../../packages/core-runtime/src/index.ts';
import { liveWork } from './schedules-harness.ts';
import { age, append, eventIds } from './aw-13-retention-world.ts';
import { gate, pausedAfter, queuedAsk } from './aw-13-race-world.ts';
import {
  ageLease,
  awaitDue,
  drain,
  noDatabase,
  t,
  TRACE_KEY,
  useAw13World,
} from './aw-13-world.ts';

useAw13World('trexp_stale_after_takeover');

it.skipIf(noDatabase)(
  'Trace export: a stale body sent after a takeover and a delete hides no later span',
  async () => {
    const s = t.alpha;
    const work = await liveWork(s, 'trace export stale body after takeover', 1_000);
    const runId = String(work.picked['runId']);
    const traceR = derivedId(TRACE_KEY, ['trace', s.business, runId], 32);
    const spanOf = (id: string): string => derivedId(TRACE_KEY, ['span', s.business, id], 16);
    const held = (id: string): boolean => t.target.spans.get(traceR)?.has(spanOf(id)) === true;
    await drain(s);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    const before = new Set(await eventIds(runId));

    const land = await queuedAsk(s);
    await append(runId, 150);
    await awaitDue(s);
    await drain(s);
    await append(runId, 1);
    await awaitDue(s);

    // A's second transaction is its first body's renewal: A stalls once it has committed.
    const paused = gate();
    const sentByA: string[] = [];
    const rival = connect(s.db.appUrl, { max: 1, source: 'trace-export-rival' });
    const a = exportOnce(pausedAfter(s.db.app, 2, paused), s.business, TRACE_KEY, async (body) => {
      sentByA.push(body);
      return await t.target.deliver(body);
    });
    try {
      await paused.reached;
      await ageLease(s);
      expect(await exportOnce(rival, s.business, TRACE_KEY, t.target.deliver)).toMatchObject({
        kind: 'delivered',
      });
      await append(runId, 1);
      await awaitDue(s);
      expect(await exportOnce(rival, s.business, TRACE_KEY, t.target.deliver)).toMatchObject({
        kind: 'delivered',
      });
      await land();
      expect(t.target.stored.has(traceR), 'the queued delete took the whole trace').toBe(false);
      paused.release();
      expect(await a, 'A’s next renewal finds its lease gone').toEqual({ kind: 'held' });
    } finally {
      paused.release();
      await Promise.allSettled([a]);
      await rival.close();
    }
    const fresh = (await eventIds(runId)).filter((id) => !before.has(id));
    expect(fresh).toHaveLength(152);
    expect(sentByA, 'A sent its stale first body').toHaveLength(1);
    expect(
      fresh.filter(held),
      'the stale body restored E1..E100 only',
    ).toEqual(fresh.slice(0, 100));

    for (let round = 0; round < 3; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await expireOnce(s.db.app, s.business, TRACE_KEY, t.target.expiry);
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await drain(s);
    }
    expect(
      fresh.filter((id) => !held(id)),
      'every in-window span E1..E152 is held',
    ).toEqual([]);
  },
);
