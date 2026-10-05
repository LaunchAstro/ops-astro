// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace export (#475, #963): two exporters start from the same cursor while
// run R's delete is owed. The failing one waits on the target while the
// healthy one runs a whole tick on its own connection, then fails without
// storing anything; three times over. The failing one's gap must never move
// the cursor behind where the healthy one left it, and the unrelated run S,
// past R's 2,001 pending events, is delivered.

import { expect, it } from 'vitest';
import { exportDeployment } from '../../apps/api/trace-exporter.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { Deliver } from '../../packages/core-runtime/src/index.ts';
import { derivedId, exportOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { liveWork } from './schedules-harness.ts';
import { age, append, eventIds } from './aw-13-retention-world.ts';
import { behind, gate, queuedAsk } from './aw-13-race-world.ts';
import { awaitDue, drain, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trexp_failing_exporter');

it.skipIf(noDatabase)(
  'Trace export: a failing exporter never undoes a healthy exporter’s progress, and a later run is delivered',
  async () => {
    const s = t.alpha;
    const work = await liveWork(s, 'trace export failing exporter', 1_000);
    const runId = String(work.picked['runId']);
    await drain(s);
    await age(runId, TRACE_WINDOW_DAYS + 1);

    // The ask at C0, its delete queued and never landed; E1..E150 exported.
    await queuedAsk(s);
    await append(runId, 150);
    await awaitDue(s);
    await drain(s);

    // 2,001 more R events ahead of E150, then the unrelated run S.
    await append(runId, 2_001);
    const later = await liveWork(s, 'trace export run S', 1_000);
    const runS = String(later.picked['runId']);
    const traceS = derivedId(TRACE_KEY, ['trace', s.business, runS], 32);
    const spansS = (await eventIds(runS)).map((id) =>
      derivedId(TRACE_KEY, ['span', s.business, id], 16),
    );
    await awaitDue(s);

    const healthy = connect(s.db.appUrl, { max: 1, source: 'trace-export-healthy' });
    const sole = async (): Promise<readonly string[]> => await Promise.resolve([s.business]);
    const seen = [await behind(s)];
    try {
      for (let round = 0; round < 3; round += 1) {
        const paused = gate();
        const failing: Deliver = async () => {
          await paused.arrive();
          return { ok: false, fault: 'status', status: 503 };
        };
        const a = exportOnce(s.db.app, s.business, TRACE_KEY, failing);
        try {
          // eslint-disable-next-line no-await-in-loop -- A waits on its first body, or has none
          await Promise.race([paused.reached, a]);
          // eslint-disable-next-line no-await-in-loop -- B's whole tick while A waits
          await exportDeployment(healthy, sole, TRACE_KEY, t.target.deliver);
          // eslint-disable-next-line no-await-in-loop -- where B left the cursor
          seen.push(await behind(s));
          paused.release();
          // eslint-disable-next-line no-await-in-loop -- A's gap, or nothing to read
          expect(['gap', 'idle']).toContain((await a).kind);
          // eslint-disable-next-line no-await-in-loop -- where A's gap left it
          seen.push(await behind(s));
        } finally {
          paused.release();
          // eslint-disable-next-line no-await-in-loop -- A ends before the next round
          await Promise.allSettled([a]);
        }
      }
      expect(seen, 'the cursor never moves back: A undoes none of B’s ticks').toEqual(
        seen.toSorted((x, y) => x - y),
      );

      for (let tick = 0; tick < 3; tick += 1) {
        // eslint-disable-next-line no-await-in-loop -- B's ticks, one after another
        await exportDeployment(healthy, sole, TRACE_KEY, t.target.deliver);
      }
    } finally {
      await healthy.close();
    }
    const stored = t.target.spans.get(traceS) ?? new Set<string>();
    expect(spansS.length).toBeGreaterThan(0);
    expect(
      spansS.filter((id) => !stored.has(id)),
      'S is delivered past R’s pending events',
    ).toEqual([]);
  },
  300_000,
);
