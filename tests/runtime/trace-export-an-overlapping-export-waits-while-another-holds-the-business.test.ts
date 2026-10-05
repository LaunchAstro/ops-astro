// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace export (#475, Sol C1b-FIX3.1): two exports start on the same batch
// while a run's delete is owed. Before the lease, the faster stored the owed
// tail and advanced; the queued delete then took the trace; the slower stored
// only its first body, which restores the earliest owed span retention reads
// back, and its next body was refused, leaving E101..E151 missing. With one
// export per business at a time (#963), the faster, on its own connection,
// waits while the slower holds the business; the slower's gap leaves the
// cursor at its batch's place (E150), so the batch and the owed tail go again.

import { expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { Deliver, ExpiryPorts, ExportOutcome } from '../../packages/core-runtime/src/index.ts';
import {
  derivedId,
  expireOnce,
  exportOnce,
  TRACE_WINDOW_DAYS,
} from '../../packages/core-runtime/src/index.ts';
import { liveWork, rows } from './schedules-harness.ts';
import { age, append, eventIds } from './aw-13-retention-world.ts';
import { awaitDue, drain, noDatabase, spanIds, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trexp_overlapping_resend');

it.skipIf(noDatabase)(
  'Trace export: an overlapping export that stores only the first body of an owed resend leaves no tail missing',
  async () => {
    const s = t.alpha;
    const work = await liveWork(s, 'trace export overlapping resend', 1_000);
    const runId = String(work.picked['runId']);
    const traceR = derivedId(TRACE_KEY, ['trace', s.business, runId], 32);
    const spanOf = (id: string): string => derivedId(TRACE_KEY, ['span', s.business, id], 16);
    await drain(s);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    const before = new Set(await eventIds(runId));

    // The ask at C0: the store queues the delete and the caller times out.
    let queued: (() => Promise<unknown>) | undefined;
    const ports: ExpiryPorts = {
      expire: (ids) => {
        queued = async () => await t.target.expiry.expire(ids);
        return Promise.resolve({ ok: false, fault: 'timeout', status: null });
      },
      present: t.target.expiry.present,
    };
    expect((await expireOnce(s.db.app, s.business, TRACE_KEY, ports)).at(-1)).toMatchObject({
      code: 'target_timeout',
    });
    const land = queued;
    if (land === undefined) throw new Error('no delete was queued');

    // E1..E150 exported inside the window; E151 ahead of the cursor.
    await append(runId, 150);
    await awaitDue(s);
    await drain(s);
    await append(runId, 1);
    await awaitDue(s);
    const fresh = (await eventIds(runId)).filter((id) => !before.has(id));
    expect(fresh).toHaveLength(151);

    // A reads, then waits before its first body is stored; B, on its own
    // connection, starts on the same batch meanwhile.
    let reached!: () => void;
    const atTarget = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowBodies: number[] = [];
    const slow: Deliver = async (body) => {
      slowBodies.push(spanIds([body]).length);
      if (slowBodies.length === 1) {
        reached();
        await held;
        return await t.target.deliver(body);
      }
      t.target.mode = 'refusing';
      try {
        return await t.target.deliver(body);
      } finally {
        t.target.mode = 'ok';
      }
    };
    const rival = connect(s.db.appUrl, { max: 1, source: 'trace-export-rival' });
    const a = exportOnce(s.db.app, s.business, TRACE_KEY, slow);
    const fastBodies: number[] = [];
    let outcomeB: ExportOutcome | undefined;
    try {
      await atTarget;
      const fast: Deliver = async (body) => {
        fastBodies.push(spanIds([body]).length);
        return await t.target.deliver(body);
      };
      outcomeB = await exportOnce(rival, s.business, TRACE_KEY, fast);
      await land();
      expect(t.target.stored.has(traceR), 'the queued delete took the whole trace').toBe(false);
      release();
      expect(await a).toMatchObject({ kind: 'gap', code: 'target_refused' });
    } finally {
      release();
      await Promise.allSettled([a]);
      await rival.close();
    }
    expect(slowBodies, 'A stores E1..E100; its second body is refused').toEqual([100, 51]);
    const [cursor] = await rows<{ id: string }>(
      s,
      'select after_id as id from public.trace_export_cursors where business_id = $1',
      [s.business],
    );
    const restored = t.target.spans.get(traceR) ?? new Set<string>();
    expect(restored.has(spanOf(fresh[0] ?? '')), 'A restored the earliest span').toBe(true);
    expect(restored.has(spanOf(fresh[150] ?? '')), 'and not the tail').toBe(false);

    for (let round = 0; round < 3; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await expireOnce(s.db.app, s.business, TRACE_KEY, t.target.expiry);
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await drain(s);
    }
    const kept = t.target.spans.get(traceR) ?? new Set<string>();
    expect(
      fresh.filter((id) => !kept.has(spanOf(id))),
      'every in-window span E1..E151 is held',
    ).toEqual([]);
    expect(cursor?.id, "A's gap left the cursor at its batch's place (E150), not back at E1").toBe(
      fresh[149],
    );
    expect(outcomeB, 'B waits while A holds the business').toEqual({ kind: 'held' });
    expect(fastBodies, 'and sends nothing').toEqual([]);
  },
);
