// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13's exporter against a real database and a stand-in target reached
// through custody's egress. The invariant is `a_dead_exporter_corrupts_nothing`:
// a run settles with the target dead, the export records a gap and keeps its
// cursor, and once the target is back the same events go out under the same
// derived ids. Then every hostile answer is a gap that moves nothing, and
// planted content never leaves.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { derivedId, exportOnce } from '../../packages/core-runtime/src/index.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  barrier,
  capCommitted,
  handbackBody,
  liveWork,
  revisionOf,
  rows,
} from './schedules-harness.ts';
import {
  awaitDue,
  cursorOf,
  drain,
  exportDue,
  exportFor,
  noDatabase,
  spanIds,
  t,
  TRACE_KEY,
  useAw13World,
  type TargetMode,
} from './aw-13-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw13World('aw13');

async function gaps(code: string): Promise<number> {
  const found = await rows<{ n: string }>(
    t.alpha,
    'select count(*)::text as n from public.trace_export_gaps where business_id = $1 and code = $2',
    [t.alpha.business, code],
  );
  return Number(found[0]?.n);
}

async function runState(runId: unknown): Promise<string | undefined> {
  const found = await rows<{ state: string }>(
    t.alpha,
    'select state from public.planned_runs where business_id = $1 and id = $2',
    [t.alpha.business, runId],
  );
  return found[0]?.state;
}

async function eventSpanIds(runId: unknown): Promise<string[]> {
  const found = await rows<{ id: string }>(
    t.alpha,
    'select id from public.run_events where business_id = $1 and run_id = $2',
    [t.alpha.business, runId],
  );
  return found.map((row) => derivedId(TRACE_KEY, ['span', t.alpha.business, row.id], 16));
}

it('a_dead_exporter_corrupts_nothing: with the target dead a run settles, the export is a gap with its cursor kept, and later the same events go out under the same ids', async () => {
  const s = t.alpha;
  await drain(s);
  t.target.mode = 'down';
  const work = await liveWork(s, `aw13-dead-${randomUUID()}`, 1_000);
  const before = await cursorOf(s);
  const [dead, handed] = await Promise.all([
    exportDue(s),
    asAgent(s, handbackBody(work.picked), String(work.picked['credential'])),
  ]);
  appliedDetail(handed, 'task.handback');
  expect(dead).toMatchObject({ kind: 'gap', code: 'target_unreachable' });
  expect(await cursorOf(s)).toBe(before);
  expect(await gaps('target_unreachable')).toBeGreaterThan(0);
  expect(await runState(work.picked['runId'])).toBe('handed_back');

  const from = t.target.received.length;
  await drain(s);
  const sent = spanIds(t.target.received.slice(from));
  const expected = await eventSpanIds(work.picked['runId']);
  expect(expected).toHaveLength(2);
  for (const id of expected) expect(sent).toContain(id);
  expect(await exportFor(s)).toEqual({ kind: 'idle' });
});

it.each([
  ['redirect', 'target_redirect'],
  ['slow', 'target_timeout'],
  ['oversized', 'target_oversized_reply'],
  ['malformed', 'target_malformed_reply'],
  ['refusing', 'target_refused'],
] as const)(
  'AW-13 hostile target: a %s answer is a gap that changes no run, no money and no cursor',
  async (mode, code) => {
    const s = t.alpha;
    await drain(s);
    const work = await liveWork(s, `aw13-hostile-${mode}-${randomUUID()}`, 1_000);
    const cursor = await cursorOf(s);
    const committed = await capCommitted(s);
    t.target.mode = mode as TargetMode;
    expect(await exportDue(s)).toMatchObject({ kind: 'gap', code });
    expect(await cursorOf(s)).toBe(cursor);
    expect(await capCommitted(s)).toBe(committed);
    expect(await runState(work.picked['runId'])).toBe('claimed');
    expect(await gaps(code)).toBeGreaterThan(0);
  },
);

it('AW-13 canary: a planted secret, message content and a client URL never reach the target, custody or its errors', async () => {
  const s = t.alpha;
  await drain(s);
  const url = `https://client-${randomUUID()}.example/site`;
  const message = `planted message ${randomUUID()}`;
  const work = await liveWork(s, `aw13-canary ${url}`, 1_000);
  appliedDetail(
    await asPerson(s, {
      command: 'task.comment',
      operationId: randomUUID(),
      recordId: work.taskId,
      expectedRevision: await revisionOf(s, work.taskId),
      body: message,
      audience: 'internal',
    }),
    'task.comment',
  );
  appliedDetail(
    await asAgent(
      s,
      { ...handbackBody(work.picked), report: { summary: `${message} ${url}` } },
      String(work.picked['credential']),
    ),
    'task.handback',
  );
  const from = t.target.received.length;
  await drain(s);
  const sent = t.target.received.slice(from).join('\n');
  expect(sent.length).toBeGreaterThan(0);
  for (const needle of [url, message, t.target.canary, work.taskId, String(work.picked['runId'])]) {
    expect(sent.includes(needle), needle).toBe(false);
    expect(t.target.custody.stderr().includes(needle), needle).toBe(false);
  }
});

it('AW-13 two exporters at once: a slower export that read an older batch never moves the cursor back', async () => {
  const s = t.alpha;
  await drain(s);
  await liveWork(s, `aw13-race-a-${randomUUID()}`, 1_000);
  await awaitDue(s);
  // The slow export reads its batch, then waits at the target past its lease
  // (#963) while another export takes over and delivers the same batch and a
  // newer one.
  let reached!: () => void;
  const atTarget = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = exportOnce(t.alpha.db.app, s.business, TRACE_KEY, async (body) => {
    reached();
    await held;
    return await t.target.deliver(body);
  });
  await atTarget;
  await rows(
    s,
    `update public.trace_export_cursors set lease_until = clock_timestamp() - interval '1 second'
      where business_id = $1`,
    [s.business],
  );
  await drain(s);
  await liveWork(s, `aw13-race-b-${randomUUID()}`, 1_000);
  await drain(s);
  const ahead = await cursorOf(s);
  release();
  expect((await slow).kind).toBe('delivered');
  expect(await cursorOf(s)).toBe(ahead);
});

async function replayCall(s: typeof t.alpha, leaseId: unknown, late = false): Promise<void> {
  await rows(
    s,
    `insert into public.model_calls
      (business_id, id, run_id, step_id, lease_id, version_id, reservation_id,
       operation_key, route_key, credential_kind, state, reserved_minor, actual_minor,
       accepted_at, ended_at)
     select l.business_id, $2, l.run_id, st.id, l.id, r.version_id, r.id,
            'scripted_replay', 'replay', 'replay', 'settled', 1, 1,
            now() + case when $4 then interval '10 minutes' else interval '0' end,
            now() + case when $4 then interval '10 minutes' else interval '0' end
       from public.leases l
       join public.reservations r on r.business_id = l.business_id and r.id = l.reservation_id
       join public.planned_steps st on st.business_id = l.business_id and st.run_id = l.run_id
      where l.business_id = $1 and l.id = $3 order by st.ordinal limit 1`,
    [s.business, randomUUID(), leaseId, late],
  );
}

it('terminal export shows the recorded outcome and call usage only from its business, run, lease and event time', async () => {
  const s = t.alpha;
  await drain(s);
  const canary = `synthetic message page and tool output ${randomUUID()}`;
  const work = await liveWork(s, canary, 1_000);
  const other = await liveWork(s, `another run ${randomUUID()}`, 1_000);
  const foreign = await liveWork(t.bravo, `another business ${randomUUID()}`, 1_000);
  await replayCall(s, work.picked['leaseId']);
  await replayCall(s, work.picked['leaseId'], true);
  await replayCall(s, other.picked['leaseId']);
  await replayCall(t.bravo, foreign.picked['leaseId']);
  appliedDetail(
    await asAgent(
      s,
      {
        ...handbackBody(work.picked),
        report: { summary: canary },
      },
      String(work.picked['credential']),
    ),
    'task.handback',
  );
  const from = t.target.received.length;
  await drain(s);
  const body = t.target.received.slice(from).join('\n');
  expect(body).toContain('"key":"ops-astro.outcome","value":{"stringValue":"completed"}');
  expect(body).toContain('"key":"ops-astro.usage.model_calls","value":{"intValue":"1"}');
  expect(body).toContain('"key":"ops-astro.usage.settled_calls","value":{"intValue":"1"}');
  expect(body).not.toContain(canary);
  for (const raw of [work.taskId, String(work.picked['runId']), s.business, t.bravo.business])
    expect(body).not.toContain(raw);
});

it('an exporter observed mid-run records the target outage while handback finishes and later catches up', async () => {
  const s = t.alpha;
  await drain(s);
  const work = await liveWork(s, `outage replay ${randomUUID()}`, 1_000);
  const before = await cursorOf(s);
  const arrived = barrier();
  const resume = barrier();
  t.target.tamper = async (_method, body) => {
    arrived.release();
    await resume.held;
    return body;
  };
  const pending = exportDue(s);
  let outage: Awaited<typeof pending>;
  try {
    await Promise.race([
      arrived.held,
      pending.then(() => {
        throw new Error('export ended before reaching the target');
      }),
    ]);
    t.target.mode = 'down';
    resume.release();
    const [exported, handed] = await Promise.all([
      pending,
      asAgent(s, handbackBody(work.picked), String(work.picked['credential'])),
    ]);
    outage = exported;
    appliedDetail(handed, 'task.handback');
    expect(await runState(work.picked['runId'])).toBe('handed_back');
  } finally {
    resume.release();
    t.target.tamper = undefined;
  }
  expect(outage).toMatchObject({ kind: 'gap', code: 'target_unreachable' });
  expect(await cursorOf(s)).toBe(before);
  expect(await gaps('target_unreachable')).toBeGreaterThan(0);
  const from = t.target.received.length;
  await drain(s);
  const sent = spanIds(t.target.received.slice(from));
  for (const id of await eventSpanIds(work.picked['runId'])) expect(sent).toContain(id);
  expect(await exportFor(s)).toEqual({ kind: 'idle' });
});
