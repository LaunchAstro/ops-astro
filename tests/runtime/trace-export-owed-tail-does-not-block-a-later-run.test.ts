// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace export (#475): an owed run's delayed delete lands after
// 150 of its fresh events exported. The export then has to send that tail
// whole, and a target that stores at most 150 spans per body answers 413. The
// owed tail must not hold the cursor so that a later unrelated run never
// exports while the tail is still inside the window.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { Deliver, ExpiryPorts } from '../../packages/core-runtime/src/index.ts';
import {
  derivedId,
  expireOnce,
  exportOnce,
  TRACE_WINDOW_DAYS,
} from '../../packages/core-runtime/src/index.ts';
import { liveWork, rows } from './schedules-harness.ts';
import { age } from './aw-13-retention-world.ts';
import { awaitDue, drain, noDatabase, spanIds, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trexp_owed_tail_bounded');

/** The most spans the target stores in one body; a larger one is refused with 413, nothing stored. */
const BODY_LIMIT = 150;

it.skipIf(noDatabase)(
  'Trace export: an oversized owed tail does not block a later run from exporting',
  async () => {
    const s = t.alpha;
    // One registered run R, exported to C0, its original events aged past the window.
    const work = await liveWork(s, 'trace export owed tail R', 1_000);
    const runId = String(work.picked['runId']);
    const traceR = derivedId(TRACE_KEY, ['trace', s.business, runId], 32);
    await drain(s);
    await age(runId, TRACE_WINDOW_DAYS + 1);

    // The delivery port: up to 150 spans per body reach the target; a larger body gets 413.
    const bodies: number[] = [];
    const limited: Deliver = async (body) => {
      const count = spanIds([body]).length;
      bodies.push(count);
      if (count > BODY_LIMIT) return { ok: true, status: 413, body: '{}' };
      return await t.target.deliver(body);
    };
    const exportLimited = async (): Promise<Awaited<ReturnType<typeof exportOnce>>> =>
      await exportOnce(s.db.app, s.business, TRACE_KEY, limited);

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

    // The ask at C0: the store queues the delete of R and the caller times out.
    let queued: (() => Promise<unknown>) | undefined;
    const ports: ExpiryPorts = {
      expire: async (ids) => {
        expect(ids).toContain(traceR);
        queued = async () => await t.target.expiry.expire(ids);
        return { ok: false, fault: 'timeout', status: null };
      },
      present: t.target.expiry.present,
    };
    expect((await expireOnce(s.db.app, s.business, TRACE_KEY, ports)).at(-1)).toMatchObject({
      code: 'target_timeout',
    });
    if (queued === undefined) throw new Error('no delete was queued');

    // 150 fresh events of R; the export drains, its first two bodies 100 and 150 spans.
    await append(150);
    await awaitDue(s);
    for (let round = 0; round < 10; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- one batch after another
      if ((await exportLimited()).kind === 'idle') break;
    }
    expect(bodies.slice(0, 2)).toEqual([100, 150]);
    expect(t.target.stored.has(traceR)).toBe(true);

    // The queued delete lands; E151 appends to R; an unrelated run S starts with a fresh event.
    await queued();
    expect(t.target.stored.has(traceR)).toBe(false);
    await append(1);
    const other = await liveWork(s, 'trace export unrelated S', 1_000);
    const traceS = derivedId(TRACE_KEY, ['trace', s.business, String(other.picked['runId'])], 32);
    await awaitDue(s);

    // Export and retention, again and again, no ageing and no further events.
    const outcomes: string[] = [];
    for (let round = 0; round < 8; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- export, then retention, in turn
      const outcome = await exportLimited();
      outcomes.push(
        outcome.kind === 'idle' || outcome.kind === 'held'
          ? outcome.kind
          : `${outcome.kind}:${outcome.spans}${'code' in outcome ? `:${outcome.code}` : ''}`,
      );
      // eslint-disable-next-line no-await-in-loop -- export, then retention, in turn
      await expireOnce(s.db.app, s.business, TRACE_KEY, t.target.expiry);
    }

    const fresh = (
      await rows<{ id: string }>(
        s,
        'select id from public.run_events where business_id = $1 and run_id = $2 order by tx, id',
        [s.business, runId],
      )
    )
      .map((row) => row.id)
      .filter((id) => !before.has(id));
    expect(fresh).toHaveLength(151);
    const heldR = t.target.spans.get(traceR) ?? new Set<string>();
    const missingR = fresh
      .map((id, at) => ({
        event: `E${String(at + 1)}`,
        span: derivedId(TRACE_KEY, ['span', s.business, id], 16),
      }))
      .filter(({ span }) => !heldR.has(span))
      .map(({ event }) => event);

    expect(
      t.target.stored.has(traceS),
      `S's fresh trace exports without waiting for R's events to age (outcomes ${outcomes.join(', ')})`,
    ).toBe(true);
    expect(missingR, `R's in-window spans are restored (outcomes ${outcomes.join(', ')})`).toEqual(
      [],
    );
  },
);
