// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace export (#963, Sol PRV-oa-963-R1.2): export A reads batch X (E151)
// while run R's delete is owed; the target accepts A's first body (E1..E100)
// but the call times out, and the target stores it later. A's hold on the
// business runs out; B, on its own connection, delivers X, then D delivers
// Y (E152). The queued delete takes the trace, and only then does A's body
// land. Retention and export, with nothing new, must bring back every
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
import { queuedAsk } from './aw-13-race-world.ts';
import {
  ageLease,
  awaitDue,
  drain,
  noDatabase,
  t,
  TRACE_KEY,
  useAw13World,
} from './aw-13-world.ts';

useAw13World('trexp_timed_out_body');

it.skipIf(noDatabase)(
  'Trace export: a timed-out body the target stores after its hold hides no later span',
  async () => {
    const s = t.alpha;
    const work = await liveWork(s, 'trace export timed-out body', 1_000);
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

    // A's first body: accepted, the call times out, and the target stores it later.
    const queued: string[] = [];
    expect(
      await exportOnce(s.db.app, s.business, TRACE_KEY, (body) => {
        queued.push(body);
        return Promise.resolve({ ok: false, fault: 'timeout', status: null });
      }),
    ).toMatchObject({ kind: 'gap', code: 'target_timeout' });
    expect(queued).toHaveLength(1);

    const rival = connect(s.db.appUrl, { max: 1, source: 'trace-export-rival' });
    try {
      expect(
        await exportOnce(rival, s.business, TRACE_KEY, t.target.deliver),
        'B waits while A’s hold runs',
      ).toEqual({ kind: 'held' });
      await ageLease(s);
      expect(await exportOnce(rival, s.business, TRACE_KEY, t.target.deliver)).toMatchObject({
        kind: 'delivered',
      });
      await append(runId, 1);
      await awaitDue(s);
      expect(await exportOnce(rival, s.business, TRACE_KEY, t.target.deliver)).toMatchObject({
        kind: 'delivered',
      });
    } finally {
      await rival.close();
    }
    await land();
    expect(t.target.stored.has(traceR), 'the queued delete took the whole trace').toBe(false);
    expect(await t.target.deliver(queued[0] ?? '')).toMatchObject({ ok: true });

    const fresh = (await eventIds(runId)).filter((id) => !before.has(id));
    expect(fresh).toHaveLength(152);
    expect(fresh.filter(held), 'the late body restored E1..E100 only').toEqual(fresh.slice(0, 100));

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
