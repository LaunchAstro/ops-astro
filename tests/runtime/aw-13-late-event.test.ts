// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13: an event whose transaction commits late still leaves. An event's
// time is its transaction's start, so a slow writer's event can commit after
// a newer one was exported; a cursor that had moved past it would skip it for
// good, and the skip would be neither a delivery nor a gap. The exporter
// reads only what every earlier transaction has finished writing. A terminal
// event's call usage is bounded by its write instant, after the writer's
// locks, so a call that settled while a hand-back waited is counted.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { derivedId } from '../../packages/core-runtime/src/index.ts';
import {
  appliedDetail,
  asAgent,
  awaitParked,
  handbackBody,
  holdRows,
  liveWork,
  racer,
  rows,
} from './schedules-harness.ts';
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

/** A writer whose transaction starts first and commits last: open until `commit`. */
async function holdLateEvent(
  event: EventRow,
): Promise<{ readonly id: string; readonly commit: () => Promise<void> }> {
  const s = t.alpha;
  const id = randomUUID();
  const database = racer(s);
  let wrote!: () => void;
  const written = new Promise<void>((resolve) => {
    wrote = resolve;
  });
  let release!: () => void;
  const committing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = database.withBusiness(s.business, async (tx) => {
    await tx.query(
      `insert into public.run_events
         (business_id, id, run_id, task_id, position, kind, lease_id, attempt_id, actor_id, detail)
       values ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8, '{}'::jsonb)`,
      [
        s.business,
        id,
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
  await Promise.race([written, done]);
  let closed = false;
  return {
    id,
    commit: async () => {
      release();
      if (closed) return;
      closed = true;
      await Promise.allSettled([done]);
      await database.close();
    },
  };
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

  const late = await holdLateEvent(event);
  try {
    // A newer event commits and an export runs while the late one is open.
    await liveWork(s, `aw13-late-b-${randomUUID()}`, 1_000);
    const from = t.target.received.length;
    await exportFor(s);
    await late.commit();
    await drain(s);
    const sent = spanIds(t.target.received.slice(from));
    expect(sent).toContain(derivedId(TRACE_KEY, ['span', s.business, late.id], 16));
  } finally {
    await late.commit();
  }
});

it('AW-13 late commit: a supplied transaction or write stamp is replaced by the writer’s own', async () => {
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
         (business_id, id, run_id, task_id, position, kind, lease_id, attempt_id, actor_id, detail, tx,
          written_at)
       select $1, $2, run_id, task_id, (select max(position) + 1 from public.run_events
                                          where business_id = $1 and task_id = $4),
              'claimed', lease_id, attempt_id, actor_id, '{}'::jsonb, '1'::xid8,
              '2000-01-01T00:00:00Z'
         from public.run_events where business_id = $1 and id = $3`,
      [s.business, forgedId, event.id, event.taskId],
    );
    return await tx.query<{ own: boolean }>(
      `select tx = pg_current_xact_id() and written_at >= now() as own from public.run_events
        where business_id = $1 and id = $2`,
      [s.business, forgedId],
    );
  });
  expect(stamped[0]?.own).toBe(true);
});

interface TraceBody {
  readonly resourceSpans: readonly {
    readonly scopeSpans: readonly {
      readonly spans: readonly {
        readonly spanId: string;
        readonly attributes: readonly { readonly key: string; readonly value: unknown }[];
      }[];
    }[];
  }[];
}

async function reservedCall(s: typeof t.alpha, leaseId: unknown): Promise<string> {
  const callId = randomUUID();
  await rows(
    s,
    `insert into public.model_calls
      (business_id, id, run_id, step_id, lease_id, version_id, reservation_id,
       operation_key, state, reserved_minor)
     select l.business_id, $2, l.run_id, st.id, l.id, r.version_id, r.id,
            'scripted_replay', 'reserved', 1
       from public.leases l
       join public.reservations r on r.business_id = l.business_id and r.id = l.reservation_id
       join public.planned_steps st on st.business_id = l.business_id and st.run_id = l.run_id
      where l.business_id = $1 and l.id = $3 order by st.ordinal limit 1`,
    [s.business, callId, leaseId],
  );
  return callId;
}

/** The exported attributes of one event's span, from the bodies the target received since `from`. */
function usageOf(from: number, eventId: string): Map<string, unknown> {
  const span = derivedId(TRACE_KEY, ['span', t.alpha.business, eventId], 16);
  const terminal = t.target.received
    .slice(from)
    .flatMap((sent) => (JSON.parse(sent) as TraceBody).resourceSpans)
    .flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
    .find((candidate) => candidate.spanId === span);
  return new Map(terminal?.attributes.map(({ key, value }) => [key, value]));
}

it('terminal call usage counts a call that settled while the hand-back waited for its locks', async () => {
  const s = t.alpha;
  await drain(s);
  const work = await liveWork(s, `lock wait replay ${randomUUID()}`, 1_000);
  const callId = await reservedCall(s, work.picked['leaseId']);
  const holder = await holdRows(s, 'records', [work.taskId]);
  const handed = asAgent(s, handbackBody(work.picked), String(work.picked['credential']));
  try {
    await awaitParked(s, 'records', 1);
    await rows(
      s,
      `update public.model_calls set state = 'settled', actual_minor = 1, route_key = 'replay',
              credential_kind = 'replay', ended_at = clock_timestamp()
        where business_id = $1 and id = $2`,
      [s.business, callId],
    );
  } finally {
    await holder.release();
  }
  appliedDetail(await handed, 'task.handback');
  const [event] = await rows<{ id: string; waited: boolean }>(
    s,
    `select ev.id, mc.ended_at > ev.created_at as waited
       from public.run_events ev
       join public.model_calls mc on mc.business_id = ev.business_id and mc.id = $3
      where ev.business_id = $1 and ev.run_id = $2 and ev.kind = 'handed_back'`,
    [s.business, work.picked['runId'], callId],
  );
  expect(event?.waited).toBe(true);
  const from = t.target.received.length;
  await drain(s);
  const usage = usageOf(from, String(event?.id));
  expect(usage.get('ops-astro.usage.model_calls')).toEqual({ intValue: '1' });
  expect(usage.get('ops-astro.usage.settled_calls')).toEqual({ intValue: '1' });
});
