// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13: an event whose transaction commits late still leaves. An event's
// time is its transaction's start, so a slow writer's event can commit after
// a newer one was exported; a cursor that had moved past it would skip it for
// good, and the skip would be neither a delivery nor a gap. The exporter
// reads only what every earlier transaction has finished writing.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { derivedId } from '../../packages/core-runtime/src/index.ts';
import { liveWork, racer, rows } from './schedules-harness.ts';
import {
  drain,
  exportFor,
  noDatabase,
  spanIds,
  t,
  TRACE_KEY,
  useAw13World,
} from './aw-13-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw13World('aw13late');

interface EventRow {
  readonly runId: string;
  readonly taskId: string;
  readonly position: string;
  readonly leaseId: string;
  readonly attemptId: string;
  readonly actorId: string;
}

it('AW-13 late commit: an event committed after a newer one was exported still leaves', async () => {
  const s = t.alpha;
  await drain(s);
  const first = await liveWork(s, `aw13-late-a-${randomUUID()}`, 1_000);
  const [event] = await rows<EventRow>(
    s,
    `select run_id as "runId", task_id as "taskId", position::text as position,
            lease_id as "leaseId", attempt_id as "attemptId", actor_id as "actorId"
       from public.run_events where business_id = $1 and run_id = $2
      order by position desc limit 1`,
    [s.business, first.picked['runId']],
  );
  if (event === undefined) throw new Error('no event to follow');

  // A writer whose transaction starts first and commits last.
  const lateId = randomUUID();
  const database = racer(s);
  let wrote!: () => void;
  const written = new Promise<void>((resolve) => {
    wrote = resolve;
  });
  let commit!: () => void;
  const committing = new Promise<void>((resolve) => {
    commit = resolve;
  });
  const late = database.withBusiness(s.business, async (tx) => {
    await tx.query(
      `insert into public.run_events
         (business_id, id, run_id, task_id, position, kind, lease_id, attempt_id, actor_id, detail)
       values ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8, '{}'::jsonb)`,
      [
        s.business,
        lateId,
        event.runId,
        event.taskId,
        Number(event.position) + 1,
        event.leaseId,
        event.attemptId,
        event.actorId,
      ],
    );
    wrote();
    await committing;
  });
  try {
    await written;
    // A newer event commits and an export runs while the late one is open.
    await liveWork(s, `aw13-late-b-${randomUUID()}`, 1_000);
    const from = t.target.received.length;
    await exportFor(s);
    commit();
    await late;
    await drain(s);
    const sent = spanIds(t.target.received.slice(from));
    expect(sent).toContain(derivedId(TRACE_KEY, ['span', s.business, lateId], 16));
  } finally {
    commit();
    await late.catch(() => undefined);
    await database.close();
  }
});

it('AW-13 late commit: a supplied transaction stamp is replaced by the writer’s own', async () => {
  const s = t.alpha;
  const [event] = await rows<EventRow & { id: string }>(
    s,
    `select id, run_id as "runId", task_id as "taskId", position::text as position,
            lease_id as "leaseId", attempt_id as "attemptId", actor_id as "actorId"
       from public.run_events where business_id = $1 order by position desc limit 1`,
    [s.business],
  );
  if (event === undefined) throw new Error('no event to follow');
  const forgedId = randomUUID();
  const stamped = await t.alpha.db.app.withBusiness(s.business, async (tx) => {
    await tx.query(
      `insert into public.run_events
         (business_id, id, run_id, task_id, position, kind, lease_id, attempt_id, actor_id, detail, tx)
       select $1, $2, run_id, task_id, (select max(position) + 1 from public.run_events
                                          where business_id = $1 and task_id = $4),
              'claimed', lease_id, attempt_id, actor_id, '{}'::jsonb, '1'::xid8
         from public.run_events where business_id = $1 and id = $3`,
      [s.business, forgedId, event.id, event.taskId],
    );
    return await tx.query<{ own: boolean }>(
      `select tx = pg_current_xact_id() as own from public.run_events
        where business_id = $1 and id = $2`,
      [s.business, forgedId],
    );
  });
  expect(stamped[0]?.own).toBe(true);
});
