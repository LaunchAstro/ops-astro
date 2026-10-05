// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#475): an owed run's tail longer than one export body goes
// in several bodies, its earliest span first. A queued delete that lands
// between two of them leaves a trace that reads present without the earlier
// spans, so retention reads the run's earliest owed span back, finds it gone
// and sends the tail again. That read goes through custody's one observation
// route: one identifier segment, any other shape refused before a socket. A
// body the target refuses as too large (413) is a gap with its own code.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { TRACE_CREDENTIAL, TRACE_DESTINATION } from '../../apps/api/trace-exporter.ts';
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

useAw13World('trret_first_owed_span');

/** The run's event ids, in the export's order. */
async function eventIds(runId: string): Promise<string[]> {
  return (
    await rows<{ id: string }>(
      t.alpha,
      'select id from public.run_events where business_id = $1 and run_id = $2 order by tx, id',
      [t.alpha.business, runId],
    )
  ).map((row) => row.id);
}

/** Appends `count` events to the run, each after its last. */
async function append(runId: string, count: number): Promise<void> {
  const s = t.alpha;
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
       from public.run_events ev where business_id = $1 and run_id = $2
      order by ev.position desc limit 1`,
    [s.business, runId],
  );
  if (last === undefined) throw new Error('no event to follow');
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (let n = 1; n <= count; n += 1) {
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
          Number(last.position) + n,
          last.leaseId,
          last.attemptId,
          last.actorId,
        ],
      );
    }
  });
}

it.skipIf(noDatabase)(
  'Trace retention: a delete landing between two bodies of an owed resend is found and the tail sent again',
  async () => {
    const s = t.alpha;
    const work = await liveWork(s, 'trace retention owed tail split', 1_000);
    const runId = String(work.picked['runId']);
    const traceR = derivedId(TRACE_KEY, ['trace', s.business, runId], 32);
    await drain(s);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    const before = new Set(await eventIds(runId));

    // The ask: the store queues the delete and the caller times out.
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

    // 150 fresh events go out; then one more, and the owed 150 go again in two bodies.
    await append(runId, 150);
    await awaitDue(s);
    await drain(s);
    await append(runId, 1);
    await awaitDue(s);
    const bodies: number[] = [];
    const between: Deliver = async (body) => {
      bodies.push(spanIds([body]).length);
      const answer = await t.target.deliver(body);
      if (bodies.length === 1) await land();
      return answer;
    };
    expect(await exportOnce(s.db.app, s.business, TRACE_KEY, between)).toMatchObject({
      kind: 'delivered',
    });
    expect(bodies, 'the earliest owed hundred first, the rest with the batch').toEqual([100, 51]);
    expect(t.target.stored.has(traceR), 'the trace reads present with the later body').toBe(true);

    for (let round = 0; round < 3; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await expireOnce(s.db.app, s.business, TRACE_KEY, t.target.expiry);
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await drain(s);
    }
    const fresh = (await eventIds(runId)).filter((id) => !before.has(id));
    expect(fresh).toHaveLength(151);
    const held = t.target.spans.get(traceR) ?? new Set<string>();
    const lost = fresh.filter(
      (id) => !held.has(derivedId(TRACE_KEY, ['span', s.business, id], 16)),
    );
    expect(lost, 'every fresh span is held again').toEqual([]);
  },
);

it.skipIf(noDatabase)(
  'Trace retention: custody reads one observation by one id segment and refuses any other shape',
  async () => {
    const ask = async (method: string, path: string): Promise<unknown> =>
      await t.target.custody.dispatch(TRACE_CREDENTIAL, {
        destination: TRACE_DESTINATION,
        path,
        method,
        body: '',
        timeoutMs: 500,
        maxResponseBytes: 4_096,
      } as never);
    t.target.mode = 'ok';
    expect(await ask('GET', '/api/public/observations/0123456789abcdef')).toMatchObject({
      kind: 'answered',
      outbound: { status: 404 },
    });
    const refused: [string, string][] = [
      ['GET', '/api/public/observations'],
      ['GET', '/api/public/observations/'],
      ['GET', '/api/public/observations/a/b'],
      ['GET', '/api/public/observations/..'],
      ['GET', '/api/public/observation/0123456789abcdef'],
      ['GET', '/api/public/observations/0123456789abcdef?fields=all'],
      ['DELETE', '/api/public/observations/0123456789abcdef'],
    ];
    for (const [method, path] of refused) {
      // eslint-disable-next-line no-await-in-loop -- one request after another
      expect(await ask(method, path), `${method} ${path}`).toMatchObject({
        kind: 'answered',
        outbound: { ok: false, fault: 'bad_path' },
      });
    }
  },
);

it.skipIf(noDatabase)(
  'Trace export: a body the target refuses as too large is a gap of its own',
  async () => {
    const s = t.alpha;
    await drain(s);
    await liveWork(s, 'trace export body too large', 1_000);
    await awaitDue(s);
    const tooLarge: Deliver = () => Promise.resolve({ ok: false, fault: 'status', status: 413 });
    expect(await exportOnce(s.db.app, s.business, TRACE_KEY, tooLarge)).toMatchObject({
      kind: 'gap',
      code: 'target_oversized_body',
    });
    const [gap] = await rows<{ code: string }>(
      s,
      'select code from public.trace_export_gaps where business_id = $1 order by recorded_at desc limit 1',
      [s.business],
    );
    expect(gap?.code).toBe('target_oversized_body');
  },
);
