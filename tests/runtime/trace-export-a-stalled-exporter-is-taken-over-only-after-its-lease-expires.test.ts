// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace export (#963): one export per business at a time, by a lease on the
// export cursor's row. Export A takes the lease and reads batch X (E151)
// while run R's delete is owed, then stalls before it sends anything. B, on
// its own connection, is held while A's lease runs, and takes over once it
// has expired: it delivers X, then Y (E152). The queued delete takes the
// trace. A wakes and sends nothing: its lease is gone. Every in-window span
// E1..E152 ends up held.

import { expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { TraceDatabase } from '../../packages/core-runtime/src/index.ts';
import {
  derivedId,
  expireOnce,
  exportOnce,
  TRACE_WINDOW_DAYS,
} from '../../packages/core-runtime/src/index.ts';
import { liveWork, rows } from './schedules-harness.ts';
import { age, append, eventIds } from './aw-13-retention-world.ts';
import { gate, queuedAsk } from './aw-13-race-world.ts';
import { awaitDue, drain, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trexp_stalled_exporter');

it.skipIf(noDatabase)(
  'Trace export: a stalled exporter is taken over only after its lease expires, and then sends nothing',
  async () => {
    const s = t.alpha;
    const work = await liveWork(s, 'trace export stalled exporter', 1_000);
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

    // A stalls on its second transaction: the first takes the lease and reads.
    const paused = gate();
    let calls = 0;
    const stalled: TraceDatabase = {
      withBusiness: async (businessId, run) => {
        calls += 1;
        if (calls === 2) await paused.arrive();
        return await s.db.app.withBusiness(businessId, run);
      },
    };
    const sentByA: string[] = [];
    const rival = connect(s.db.appUrl, { max: 1, source: 'trace-export-rival' });
    const a = exportOnce(stalled, s.business, TRACE_KEY, async (body) => {
      sentByA.push(body);
      return await t.target.deliver(body);
    });
    try {
      await paused.reached;
      expect(
        await exportOnce(rival, s.business, TRACE_KEY, t.target.deliver),
        'B waits while A’s lease runs',
      ).toEqual({ kind: 'held' });
      await rows(
        s,
        `update public.trace_export_cursors set lease_until = clock_timestamp() - interval '1 second'
          where business_id = $1`,
        [s.business],
      );
      expect(await exportOnce(rival, s.business, TRACE_KEY, t.target.deliver)).toMatchObject({
        kind: 'delivered',
      });
      await append(runId, 1);
      await awaitDue(s);
      expect(await exportOnce(rival, s.business, TRACE_KEY, t.target.deliver)).toMatchObject({
        kind: 'delivered',
      });
      await land();
      paused.release();
      expect(await a, 'A’s lease is gone').toEqual({ kind: 'held' });
    } finally {
      paused.release();
      await Promise.allSettled([a]);
      await rival.close();
    }
    expect(sentByA, 'A sends nothing once its lease is gone').toEqual([]);

    for (let round = 0; round < 3; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await expireOnce(s.db.app, s.business, TRACE_KEY, t.target.expiry);
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await drain(s);
    }
    const fresh = (await eventIds(runId)).filter((id) => !before.has(id));
    expect(fresh).toHaveLength(152);
    const kept = t.target.spans.get(traceR) ?? new Set<string>();
    expect(
      fresh.filter((id) => !kept.has(spanOf(id))),
      'every in-window span E1..E152 is held',
    ).toEqual([]);
  },
);
