// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#475): a run's next event
// is written in a transaction T on a separate tenant connection that stays
// open through a whole retention pass. The pass confirms the run expired; T
// then commits and the export recreates the trace. Once that event ages past
// the window, retention must delete the recreated trace.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { derivedId, expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { liveWork, racer, rows } from './schedules-harness.ts';
import { age, batchesOf } from './aw-13-retention-world.ts';
import { drain, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trret_late_commit');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The clock moves on `days`: the run's events and the business's batches all fall that far back. */
async function timePasses(runId: string, businessId: string, days: number): Promise<void> {
  if (!UUID.test(runId) || !UUID.test(businessId) || !Number.isInteger(days)) {
    throw new Error('timePasses: not a run id, business id or days');
  }
  await t.alpha.db.admin.execute(
    `do $$ begin
       set local session_replication_role = replica;
       update public.run_events set created_at = created_at - make_interval(days => ${String(days)})
        where run_id = '${runId}';
       update public.trace_expiry_batches
          set recorded_at = recorded_at - make_interval(days => ${String(days)})
        where business_id = '${businessId}';
     end $$`,
  );
}

it.skipIf(noDatabase)(
  'Trace retention: a late-committing event is expired once it ages past the window',
  async () => {
    const s = t.alpha;
    // R exported in full and aged past the window: cursor C0, its trace stored.
    const work = await liveWork(s, 'trace retention late commit', 1_000);
    const runId = String(work.picked['runId']);
    const traceId = derivedId(TRACE_KEY, ['trace', s.business, runId], 32);
    await drain(s);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    const c0 = await rows<{ after_tx: string }>(
      s,
      'select after_tx::text as after_tx from public.trace_export_cursors where business_id = $1',
      [s.business],
    );
    expect(t.target.stored.has(traceId)).toBe(true);

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

    // T: R's next event on a separate tenant connection, held open.
    const eventId = randomUUID();
    const tenant = racer(s);
    let wrote!: () => void;
    const written = new Promise<void>((resolve) => {
      wrote = resolve;
    });
    let release!: () => void;
    const committing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = tenant.withBusiness(s.business, async (tx) => {
      await tx.query(
        `insert into public.run_events
           (business_id, id, run_id, task_id, position, kind, lease_id, attempt_id, actor_id, detail)
         values ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8, '{}'::jsonb)`,
        [
          s.business,
          eventId,
          runId,
          last.taskId,
          Number(last.position) + 1,
          last.leaseId,
          last.attemptId,
          last.actorId,
        ],
      );
      wrote();
      await committing;
    });
    try {
      await Promise.race([written, held]);

      // The whole pass while T is open: delete, read-back, confirmation, both resends.
      const batches = await expireOnce(s.db.app, s.business, TRACE_KEY, t.target.expiry);
      expect(batches).toEqual([{ runs: 1, confirmed: 1, code: null }]);
      expect((await batchesOf(s)).at(-1)?.expired_run_ids).toContain(runId);
      expect(t.target.stored.has(traceId)).toBe(false);

      // T commits; the export sends its event and recreates R's trace.
      release();
      await held;
    } finally {
      release();
      await Promise.allSettled([held]);
      await tenant.close();
    }
    await drain(s);
    expect(t.target.stored.has(traceId)).toBe(true);

    // The Scenario's inputs hold: T's created_at predates the batch, its stamp is above C0.
    const [stamp] = await rows<{ before: boolean; above: boolean }>(
      s,
      `select ev.created_at < (select max(recorded_at) from public.trace_expiry_batches
                                where business_id = $1) as before,
              ev.tx > $3::text::xid8 as above
         from public.run_events ev where ev.business_id = $1 and ev.id = $2`,
      [s.business, eventId, c0[0]?.after_tx ?? '0'],
    );
    expect(stamp).toEqual({ before: true, above: true });

    // The late event ages beyond the window; retention runs again.
    await timePasses(runId, s.business, TRACE_WINDOW_DAYS + 1);
    await expireOnce(s.db.app, s.business, TRACE_KEY, t.target.expiry);
    expect(
      t.target.stored.has(traceId),
      'retention must delete the recreated trace once the late event ages beyond the window',
    ).toBe(false);
  },
);
