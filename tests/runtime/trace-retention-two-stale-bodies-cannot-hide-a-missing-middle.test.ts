// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#963, the class of Sol PRV-oa-963-R1.1): run R's delete
// is owed and the export reads batch X (E251) with E1..E250 owed, three
// bodies. Export A stalls after renewing for its first body (E1..E100). Its
// lease expires; Y, on its own connection, sends the first two bodies and
// stalls after renewing for its third (E201..E251). Its lease expires; Z
// delivers everything. The queued delete takes the trace, then A and Y send
// their stale bodies: R's first and last spans are back, E101..E200 are not.
// Reading back the first and last spans alone finds R present; retention and
// export, with nothing new, must bring back every in-window span E1..E251.

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

useAw13World('trret_two_stale_bodies');

it.skipIf(noDatabase)(
  'Trace retention: two stale bodies restoring the first and last spans cannot hide a missing middle',
  async () => {
    const s = t.alpha;
    const work = await liveWork(s, 'trace retention two stale bodies', 1_000);
    const runId = String(work.picked['runId']);
    const traceR = derivedId(TRACE_KEY, ['trace', s.business, runId], 32);
    const spanOf = (id: string): string => derivedId(TRACE_KEY, ['span', s.business, id], 16);
    const held = (id: string): boolean => t.target.spans.get(traceR)?.has(spanOf(id)) === true;
    await drain(s);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    const before = new Set(await eventIds(runId));

    const land = await queuedAsk(s);
    await append(runId, 250);
    await awaitDue(s);
    await drain(s);
    await append(runId, 1);
    await awaitDue(s);

    // A stalls after its 2nd transaction (body 1's renewal), Y after its 4th (body 3's).
    const pausedA = gate();
    const pausedY = gate();
    const yConnection = connect(s.db.appUrl, { max: 1, source: 'trace-export-y' });
    const zConnection = connect(s.db.appUrl, { max: 1, source: 'trace-export-z' });
    const sent = { a: 0, y: 0 };
    const counting =
      (who: 'a' | 'y') =>
      async (body: string): ReturnType<typeof t.target.deliver> => {
        sent[who] += 1;
        return await t.target.deliver(body);
      };
    const a = exportOnce(pausedAfter(s.db.app, 2, pausedA), s.business, TRACE_KEY, counting('a'));
    let y: ReturnType<typeof exportOnce> | undefined;
    try {
      await pausedA.reached;
      await ageLease(s);
      y = exportOnce(pausedAfter(yConnection, 4, pausedY), s.business, TRACE_KEY, counting('y'));
      await pausedY.reached;
      expect(sent, 'Y sent its first two bodies; A sent nothing yet').toEqual({ a: 0, y: 2 });
      await ageLease(s);
      expect(await exportOnce(zConnection, s.business, TRACE_KEY, t.target.deliver)).toMatchObject({
        kind: 'delivered',
      });
      await land();
      expect(t.target.stored.has(traceR), 'the queued delete took the whole trace').toBe(false);
      pausedA.release();
      expect(await a, 'A’s next renewal finds its lease gone').toEqual({ kind: 'held' });
      pausedY.release();
      await y;
    } finally {
      pausedA.release();
      pausedY.release();
      await Promise.allSettled([a, y]);
      await yConnection.close();
      await zConnection.close();
    }
    const fresh = (await eventIds(runId)).filter((id) => !before.has(id));
    expect(fresh).toHaveLength(251);
    expect(sent, 'each stale export sent one body after the delete').toEqual({ a: 1, y: 3 });
    expect(
      fresh.filter((id) => !held(id)),
      'the stale bodies left E101..E200 missing, R’s first and last spans held',
    ).toEqual(fresh.slice(100, 200));

    for (let round = 0; round < 3; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await expireOnce(s.db.app, s.business, TRACE_KEY, t.target.expiry);
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await drain(s);
    }
    expect(
      fresh.filter((id) => !held(id)),
      'every in-window span E1..E251 is held',
    ).toEqual([]);
  },
);
