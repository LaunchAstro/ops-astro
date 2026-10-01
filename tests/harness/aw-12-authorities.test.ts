// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12 authorities at the runtime (TEST.md 2): A1 task, A2 approval, A7 the
// retry owner and A8 state transitions. The framework stand-in sits where a
// worker sits, on work really proposed, approved and picked up through the
// command entry; FP-M is its model. A3 to A5 are in the broker file beside
// this one, A6 in the egress file. Each case is the framework reaching for an
// authority and the product refusing it, with a positive control.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';
import {
  connectAsAdmin,
  type AdminConnection,
} from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { successorBody } from '../runtime/handback-footprint.ts';
import {
  appliedDetail,
  approve,
  asAgent,
  handbackBody,
  liveWork,
  openSchedules,
  rows,
  type Detail,
  type Work,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { attempts, work as droppableWork } from '../runtime/t3e1-drops-reads.ts';
import { fakeClock } from './fake-clock-corpus.ts';
import { fakeModel, type ModelReply } from './fake-model.ts';
import { standIn } from './framework-stand-in.ts';

const url = databaseUrlFromEnvironment();
const it = url === undefined ? vitestIt.skip : vitestIt;

let s: Schedules;
let harness: AdminConnection;
const login = `aw12_harness_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

beforeAll(async () => {
  if (url === undefined) return;
  s = await openSchedules('aw12auth', 1_000_000);
  const password = randomUUID();
  await s.db.admin.execute(
    `create role ${login} login password '${password}' in role ops_astro_worker`,
  );
  // The harness's role: a login in the restricted worker role, the canary for any framework's.
  const address = new URL(s.db.appUrl);
  address.username = login;
  address.password = password;
  harness = connectAsAdmin(address.toString(), { source: 'aw-12-authorities' });
}, 180_000);

afterAll(async () => {
  await harness?.close();
  await s?.db.admin.execute(`drop role if exists ${login}`);
  await s?.db.drop();
});

/** A stand-in on FP-M, whose own retry setting is `retries`. */
function onFakeModel(retries: number) {
  const model = fakeModel([], fakeClock());
  const framework = standIn({
    settings: {},
    model: async (input) => await model.client.complete({ model: 'replay-1', input }),
    tools: new Map(),
    retries,
    read: (reply) =>
      (reply as ModelReply).kind === 'answer' ? { ok: true } : { ok: false, why: 'failed' },
  });
  return { model, framework };
}

/** Every row of every table in the product's schema that holds `canary`, as `table: count`. */
async function holding(canary: string): Promise<string[]> {
  const tables = await rows<{ name: string }>(
    s,
    `select format('%I.%I', schemaname, tablename) as name from pg_tables
      where schemaname = 'public' order by 1`,
    [],
  );
  const found: string[] = [];
  for (const { name } of tables) {
    // eslint-disable-next-line no-await-in-loop -- one table at a time
    const [hit] = await rows<{ n: string }>(
      s,
      `select count(*)::text as n from ${name} t where t::text like $1`,
      [`%${canary}%`],
    );
    if (hit !== undefined && hit.n !== '0') found.push(`${name}: ${hit.n}`);
  }
  return found;
}

/** The task's row, its versions, its history and its runs' events: what the framework must not own. */
const taskState = async (taskId: string): Promise<readonly unknown[]> =>
  await rows(
    s,
    `select (select t::text from public.records t where business_id = $1 and id = $2) as task,
            (select string_agg(v::text, ',' order by v.version) from public.proposal_versions v
               join public.proposal_lineages l on l.business_id = v.business_id and l.id = v.lineage_id
              where v.business_id = $1 and l.task_id = $2) as versions,
            (select string_agg(a.command || ':' || a.outcome, ',' order by a.seq)
               from public.audit_events a where business_id = $1 and subject_record_id = $2) as history,
            (select string_agg(e.kind, ',' order by e.position)
               from public.run_events e where business_id = $1 and task_id = $2) as events`,
    [s.business, taskId],
  );

const queued = async (taskId: string): Promise<Detail | undefined> => {
  const queue = appliedDetail(
    await asAgent(s, { command: 'task.queue', operationId: randomUUID() }),
    'task.queue',
  )['queue'] as readonly Detail[];
  return queue.find((entry) => entry['taskId'] === taskId);
};

async function taskAuthority(): Promise<void> {
  const work = await liveWork(s, `aw12 task ${randomUUID()}`, 2_000);
  const canary = `aw12-plan-canary-${randomUUID()}`;
  const { framework } = onFakeModel(0);
  framework.plan(work.taskId, [`${canary} read the brief`, `${canary} draft the reply`]);
  framework.checkpoint(work.taskId, { ...work.picked, todo: canary });
  const before = await taskState(work.taskId);
  expect(before).toMatchObject([
    { task: expect.any(String), versions: expect.any(String), history: expect.any(String) },
  ]);
  // The plan and todo are the framework's own: none of it is in any product row.
  expect(await holding(canary)).toStrictEqual([]);
  framework.store.clear();
  expect(await taskState(work.taskId)).toStrictEqual(before);
}

const fresh = (): { operationId: string } => ({ operationId: randomUUID() });

/** The framework's own resume from its checkpoint, with its token: pickup, beat, dispatch, decide. */
async function resumeFrom(work: Work, gate: Detail): Promise<readonly unknown[]> {
  const credential = String(work.picked['credential']);
  const lease = { leaseId: work.picked['leaseId'], fence: work.picked['fence'] };
  const reservationId = work.decision['reservationId'];
  return [
    await asAgent(s, { command: 'task.pickup', ...fresh(), reservationId }),
    await asAgent(s, { command: 'task.heartbeat', ...fresh(), ...lease }, credential),
    await asAgent(s, { command: 'task.dispatch', ...fresh(), ...lease }, credential),
    // Its settled credential would answer DELEGATION_NOT_LIVE; with none, it is the decision.
    await asAgent(s, { command: 'task.decide', ...fresh(), ...gate, decision: 'approve' }),
  ];
}

async function approvalAuthority(): Promise<void> {
  const work = await liveWork(s, `aw12 gate ${randomUUID()}`, 2_000);
  const { framework } = onFakeModel(0);
  framework.checkpoint(work.taskId, { ...work.picked, ...work.decision });
  // The run hands back with a successor: its next version waits on a person's gate.
  const back = appliedDetail(
    await asAgent(
      s,
      handbackBody(work.picked, successorBody(1_000)),
      String(work.picked['credential']),
    ),
    'task.handback',
  );
  const gate = { gateId: back['successorGateId'], versionId: back['successorVersionId'] };
  const leases = `select count(*)::text as n from public.leases l join public.planned_runs r
      on r.business_id = l.business_id and r.id = l.run_id where r.task_id = $1`;
  const [leasesBefore] = await rows<{ n: string }>(s, leases, [work.taskId]);

  const resumed = await resumeFrom(work, gate);
  for (const answer of resumed) expect(answer).toMatchObject({ refused: true });
  expect(resumed[3]).toMatchObject({ code: 'DELEGATION_EXCLUDES_DECISION' });
  expect(await queued(work.taskId)).toBeUndefined();
  expect(await rows(s, leases, [work.taskId])).toEqual([leasesBefore]);

  // Control: the person's gate decision is what resumes it.
  await approve(s, gate);
  const entry = await queued(work.taskId);
  const picked = await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: entry?.['reservationId'],
  });
  expect(picked).toMatchObject({ command: 'task.pickup' });
}

async function retryOwner(): Promise<void> {
  const work = await droppableWork(s);
  const { model, framework } = onFakeModel(0);
  model.fixture.mode('refuse_without_code');
  const reservations = `select count(*)::text as n from public.reservations res
      join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
      where res.business_id = $1 and run.task_id = $2`;
  const [held] = await rows<{ n: string }>(s, reservations, [s.business, work.taskId]);
  const before = await attempts(s, work.taskId);

  // One failed call: the framework surfaces it, and the product's hand-back is the retry.
  const { calls } = await framework.step('Draft the copy correction.');
  const drop = {
    ...handbackBody(work.picked),
    outcome: 'dropped',
    report: { dropCause: 'provider_unavailable' },
  };
  appliedDetail(await asAgent(s, drop, work.credential), 'task.handback');
  // The same hand-back again replays; it moves nothing more.
  appliedDetail(await asAgent(s, drop, work.credential), 'task.handback');

  const after = await attempts(s, work.taskId);
  const [heldAfter] = await rows<{ n: string }>(s, reservations, [s.business, work.taskId]);
  expect(after.slice(0, before.length)).toMatchObject([{ state: 'dropped' }]);
  expect(after.slice(before.length)).toMatchObject([{ state: 'reserved', held: 'held' }]);
  expect(Number(heldAfter?.n) - Number(held?.n)).toBe(1);
  // Every model call the framework made has its own attempt and reservation.
  expect(model.fixture.seen).toHaveLength(calls);
  expect(calls).toBe(after.length - before.length);
}

/** The run, its steps and its events, as text. */
const runRecord = async (runId: unknown): Promise<readonly unknown[]> =>
  await rows(
    s,
    `select (select t::text from public.planned_runs t where business_id = $1 and id = $2) as run,
            (select string_agg(t::text, ',' order by t.id) from public.planned_steps t
              where business_id = $1 and run_id = $2) as steps,
            (select string_agg(t::text, ',' order by t.position) from public.run_events t
              where business_id = $1 and run_id = $2) as events`,
    [s.business, runId],
  );

async function stateTransitions(): Promise<void> {
  const work = await liveWork(s, `aw12 role ${randomUUID()}`, 2_000);
  const [run] = await rows<{ id: string }>(
    s,
    `select run_id as id from public.leases where business_id = $1 and id = $2`,
    [s.business, work.picked['leaseId']],
  );
  const updates = [
    `update public.planned_runs set state = 'completed' where business_id = $1 and id = $2`,
    `update public.planned_steps set ordinal = ordinal where business_id = $1 and run_id = $2`,
    `update public.run_events set detail = '{}' where business_id = $1 and run_id = $2`,
  ];
  const before = await runRecord(run?.id);
  const codes = await Promise.all(
    updates.map(
      async (sql) =>
        await harness.execute(sql, [s.business, run?.id]).then(
          () => 'ran',
          (error: unknown) => String((error as { code?: unknown }).code),
        ),
    ),
  );
  expect(codes).toStrictEqual(['42501', '42501', '42501']);
  expect(await runRecord(run?.id)).toStrictEqual(before);
  // Control: a real statement on a real row; the application role, never the harness's, reaches it.
  const reached = await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await tx.query(
        `update public.planned_runs set state = state where business_id = $1 and id = $2 returning id`,
        [s.business, run?.id],
      ),
  );
  expect(reached).toHaveLength(1);
}

describe(
  'AW-12 authorities: a framework holds none of the eight authorities',
  { timeout: 120_000 },
  () => {
    it(
      "A1 task authority: deleting the framework's whole state store leaves the task, its revisions and history intact",
      taskAuthority,
    );
    it(
      "A2 approval authority: a framework's own resume cannot resume a run without a product gate decision",
      approvalAuthority,
    );
    it(
      'A7 the retry owner: framework retries are off: one failure gives exactly one new attempt and reservation',
      retryOwner,
    );
    it(
      "A8 state transitions: the run record cannot be updated from the harness's database role",
      stateTransitions,
    );
  },
);
