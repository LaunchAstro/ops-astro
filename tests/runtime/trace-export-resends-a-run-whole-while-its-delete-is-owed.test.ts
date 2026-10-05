// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#475): a delete the store accepted can land at any time.
// When it lands between two exports of a run's fresh events, the trace it
// leaves holds only the later ones and still reads back present. So while a
// run's delete is owed, every export that sends one of its events sends all
// its events since the delete was asked: the trace is whole after any export.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { ExpiryPorts } from '../../packages/core-runtime/src/index.ts';
import { derivedId, expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { asAgent, codeOf, handbackBody, liveWork, rows } from './schedules-harness.ts';
import { age, clearSeen } from './aw-13-retention-world.ts';
import { drain, noDatabase, spanIds, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trret_whole');

it.skipIf(noDatabase)(
  'Trace retention: an export while a delete is owed sends the run’s events since the ask, not only the new one',
  async () => {
    const s = t.alpha;
    const work = await liveWork(s, 'trace retention whole', 1_000);
    const runId = String(work.picked['runId']);
    const traceId = derivedId(TRACE_KEY, ['trace', s.business, runId], 32);
    await drain(s);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    const eventsOf = async (): Promise<string[]> =>
      (
        await rows<{ id: string }>(
          s,
          'select id from public.run_events where business_id = $1 and run_id = $2 order by position',
          [s.business, runId],
        )
      ).map((row) => row.id);
    const before = new Set(await eventsOf());

    // The store accepts the delete and queues it; a fresh handback exports; the caller times out.
    let queued: (() => Promise<unknown>) | undefined;
    const ports: ExpiryPorts = {
      expire: async (ids) => {
        queued = async () => await t.target.expiry.expire(ids);
        const answer = await asAgent(
          s,
          handbackBody(work.picked),
          String(work.picked['credential']),
        );
        expect(codeOf(answer)).toBe('applied');
        await drain(s);
        return { ok: false, fault: 'timeout', status: null };
      },
      present: t.target.expiry.present,
    };
    expect((await expireOnce(s.db.app, s.business, TRACE_KEY, ports)).at(-1)).toMatchObject({
      code: 'target_timeout',
    });
    await drain(s);
    const fresh = (await eventsOf()).filter((id) => !before.has(id));
    expect(fresh.length).toBeGreaterThan(0);

    // The accepted delete lands, then the run takes one more event.
    if (queued === undefined) throw new Error('no delete was queued');
    await queued();
    expect(t.target.stored.has(traceId)).toBe(false);
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
    const later = randomUUID();
    await s.db.app.withBusiness(s.business, async (tx) => {
      await tx.query(
        `insert into public.run_events
           (business_id, id, run_id, task_id, position, kind, lease_id, attempt_id, actor_id, detail)
         values ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8, '{}'::jsonb)`,
        [
          s.business,
          later,
          runId,
          last.taskId,
          Number(last.position) + 1,
          last.leaseId,
          last.attemptId,
          last.actorId,
        ],
      );
    });

    // The export of the later event sends the earlier fresh ones with it.
    clearSeen();
    await drain(s);
    const sent = spanIds(t.target.received);
    expect(sent).toContain(derivedId(TRACE_KEY, ['span', s.business, later], 16));
    for (const id of fresh) {
      expect(sent, 'a fresh event the late delete took goes again').toContain(
        derivedId(TRACE_KEY, ['span', s.business, id], 16),
      );
    }
  },
);
