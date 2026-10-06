// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace export (#963): export A takes the lease and reads its batch, then
// stalls before its first body's renewal. Its lease expires and B, on its own
// connection, takes it over and is still sending when A wakes. A's renewal
// asks for its own holder and version, so A stops, `held`, and sends nothing
// while B holds the business; B then delivers.

import { expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { TraceDatabase } from '../../packages/core-runtime/src/index.ts';
import { exportOnce } from '../../packages/core-runtime/src/index.ts';
import { liveWork } from './schedules-harness.ts';
import { append } from './aw-13-retention-world.ts';
import { gate } from './aw-13-race-world.ts';
import {
  ageLease,
  awaitDue,
  drain,
  noDatabase,
  t,
  TRACE_KEY,
  useAw13World,
} from './aw-13-world.ts';

useAw13World('trexp_renew_while_held');

it.skipIf(noDatabase)(
  'Trace export: a stalled exporter cannot renew while another export holds the lease',
  async () => {
    const s = t.alpha;
    const work = await liveWork(s, 'trace export renew while held', 1_000);
    const runId = String(work.picked['runId']);
    await drain(s);
    await append(runId, 1);
    await awaitDue(s);

    // A stalls before its second transaction: the first takes the lease and reads.
    const pausedA = gate();
    let calls = 0;
    const stalled: TraceDatabase = {
      withBusiness: async (businessId, run) => {
        calls += 1;
        if (calls === 2) await pausedA.arrive();
        return await s.db.app.withBusiness(businessId, run);
      },
    };
    const sentByA: string[] = [];
    const a = exportOnce(stalled, s.business, TRACE_KEY, async (body) => {
      sentByA.push(body);
      return await t.target.deliver(body);
    });
    // B holds the lease while its body waits on the target.
    const pausedB = gate();
    const rival = connect(s.db.appUrl, { max: 1, source: 'trace-export-rival' });
    let b: ReturnType<typeof exportOnce> | undefined;
    try {
      await pausedA.reached;
      await ageLease(s);
      b = exportOnce(rival, s.business, TRACE_KEY, async (body) => {
        await pausedB.arrive();
        return await t.target.deliver(body);
      });
      await pausedB.reached;
      pausedA.release();
      expect(await a, 'A’s renewal fails while B holds the lease').toEqual({ kind: 'held' });
      pausedB.release();
      expect(await b).toMatchObject({ kind: 'delivered' });
    } finally {
      pausedA.release();
      pausedB.release();
      await Promise.allSettled([a, b]);
      await rival.close();
    }
    expect(sentByA, 'A sends nothing while B holds the lease').toEqual([]);
  },
);
