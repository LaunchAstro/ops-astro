// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace export (#475): an owed run with 101 fresh events behind
// the cursor when its delayed delete lands. The export that follows sends the
// run whole, so every fresh span must be held again, the 101st included.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { ExpiryPorts } from '../../packages/core-runtime/src/index.ts';
import { derivedId, expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { liveWork, rows } from './schedules-harness.ts';
import { age, clearSeen } from './aw-13-retention-world.ts';
import { drain, exportFor, noDatabase, spanIds, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trexp_owed_run_whole');

it.skipIf(noDatabase)(
  'Trace export: a delayed delete of an owed run with 101 fresh events leaves every fresh span retrievable',
  async () => {
    const s = t.alpha;
    // An old registered run R, exported to C0 and aged past the window.
    const work = await liveWork(s, 'trace export owed resend whole', 1_000);
    const runId = String(work.picked['runId']);
    const traceId = derivedId(TRACE_KEY, ['trace', s.business, runId], 32);
    await drain(s);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    const [last] = await rows<{
      taskId: string;
      position: string;
      leaseId: string;
      attemptId: string;
      actorId: string;
    }>(
      s,
      `select task_id as "taskId", position::text as position, lease_id as "leaseId",
              attempt_id as "attemptId", actor_id as "actorId"
         from public.run_events where business_id = $1 and run_id = $2
        order by position desc limit 1`,
      [s.business, runId],
    );
    if (last === undefined) throw new Error('no event to follow');
    let position = Number(last.position);
    const append = async (count: number): Promise<void> => {
      await s.db.app.withBusiness(s.business, async (tx) => {
        for (let n = 0; n < count; n += 1) {
          position += 1;
          // eslint-disable-next-line no-await-in-loop -- one event after another, in position order
          await tx.query(
            `insert into public.run_events
               (business_id, id, run_id, task_id, position, kind, lease_id, attempt_id, actor_id, detail)
             values ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8, '{}'::jsonb)`,
            [
              s.business,
              randomUUID(),
              runId,
              last.taskId,
              position,
              last.leaseId,
              last.attemptId,
              last.actorId,
            ],
          );
        }
      });
    };
    const before = new Set(
      (
        await rows<{ id: string }>(
          s,
          'select id from public.run_events where business_id = $1 and run_id = $2',
          [s.business, runId],
        )
      ).map((row) => row.id),
    );

    // The store queues the delete of R; E1..E101 append and export while the ask is owed; the caller times out.
    let queued: (() => Promise<unknown>) | undefined;
    const ports: ExpiryPorts = {
      expire: async (ids) => {
        expect(ids).toContain(traceId);
        queued = async () => await t.target.expiry.expire(ids);
        await append(101);
        await drain(s);
        return { ok: false, fault: 'timeout', status: null };
      },
      present: t.target.expiry.present,
    };
    expect((await expireOnce(s.db.app, s.business, TRACE_KEY, ports)).at(-1)).toMatchObject({
      code: 'target_timeout',
    });
    await drain(s);

    // The queued delete lands; then E102; the export drains.
    if (queued === undefined) throw new Error('no delete was queued');
    await queued();
    expect(t.target.stored.has(traceId)).toBe(false);
    clearSeen();
    await append(1);
    await drain(s);

    // Retention and export again, no new events, the clock where it was.
    await expireOnce(s.db.app, s.business, TRACE_KEY, t.target.expiry);
    await exportFor(s);

    const fresh = (
      await rows<{ id: string }>(
        s,
        'select id from public.run_events where business_id = $1 and run_id = $2 order by tx, id',
        [s.business, runId],
      )
    )
      .map((row) => row.id)
      .filter((id) => !before.has(id));
    expect(fresh).toHaveLength(102);
    // The store holds, for R, only what reached it after the delete took the trace.
    const held = new Set(
      spanIds(t.target.received.filter((_, at) => t.target.methods[at] === 'POST')),
    );
    const missing = fresh
      .map((id, at) => ({ event: `E${String(at + 1)}`, span: derivedId(TRACE_KEY, ['span', s.business, id], 16) }))
      .filter(({ span }) => !held.has(span))
      .map(({ event }) => event);
    expect(
      missing,
      `every in-window span E1..E102 is retrievable (trace reads ${t.target.stored.has(traceId) ? 'present' : 'absent'})`,
    ).toEqual([]);
  },
);
