// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12 authorities at the runtime (TEST.md 2): A1 task, A2 approval, A7 the
// retry owner and A8 state transitions. The framework stand-in sits where a
// worker sits, on work really proposed, approved and picked up through the
// command entry; its one model client is the broker. A3 to A5 are in the broker file beside
// this one, A6 in the egress file. Each case is the framework reaching for an
// authority and the product refusing it, with a positive control.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';
import type { ModelCallResult } from '../../packages/core-custody/src/index.ts';
import {
  connectAsAdmin,
  type AdminConnection,
} from '../../packages/core-records/src/tenancy/database.ts';
import { call } from '../broker/broker-world.ts';
import {
  faultBroker,
  noDatabase,
  pass,
  room,
  s,
  useFaultWorld,
  world,
} from '../broker/aw-10-world.ts';
import { handbackFootprint, successorBody } from '../runtime/handback-footprint.ts';
import {
  appliedDetail,
  approve,
  asAgent,
  handbackBody,
  liveWork,
  rows,
  type Detail,
  type Work,
} from '../runtime/schedules-harness.ts';
import { attempts } from '../runtime/t3e1-drops-reads.ts';
import {
  callsOn,
  dropBody,
  holding,
  queued,
  runRecord,
  taskState,
} from './aw-12-authority-reads.ts';
import { standIn, type StandIn } from './framework-stand-in.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

let harness: AdminConnection;
const login = `aw12_harness_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

// The broker world: work really picked up, custody's process and the replay provider.
useFaultWorld('aw12auth');

beforeAll(async () => {
  if (noDatabase) return;
  const password = randomUUID();
  await s.db.admin.execute(
    `create role ${login} login password '${password}' in role ops_astro_worker`,
  );
  // The harness's role: a login in the restricted worker role, the canary for any framework's.
  const address = new URL(s.db.appUrl);
  address.username = login;
  address.password = password;
  harness = connectAsAdmin(address.toString(), { source: 'aw-12-authorities' });
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await s?.db.admin.execute(`drop role if exists ${login}`);
});

/** The stand-in on `work`: its one model client is the broker (AW-10's) on its lease. */
const onBroker = (work: Work, retries = 0): StandIn =>
  standIn({
    settings: {},
    model: async () => await call(work, {}, faultBroker()),
    tools: new Map(),
    retries,
    read: (reply) => ((reply as ModelCallResult).ok ? { ok: true } : { ok: false, why: 'failed' }),
  });

async function taskAuthority(): Promise<void> {
  world.provider.mode('answer');
  const work = await liveWork(s, `aw12 task ${randomUUID()}`, 2_000);
  const canary = `aw12-plan-canary-${randomUUID()}`;
  const framework = onBroker(work);
  framework.plan(work.taskId, [`${canary} read the brief`, `${canary} draft the reply`]);
  framework.checkpoint(work.taskId, { ...work.picked, todo: canary });
  // Its run, through the product: a compaction of its plan through the broker, then a hand-back.
  expect(await framework.compact(work.taskId)).toMatchObject({ ok: true });
  // Room beside the spent hold for the step to come back in (AW-10's `room`).
  await room(s, work);
  appliedDetail(
    await asAgent(s, dropBody(work), String(work.picked['credential'])),
    'task.handback',
  );
  const before = await taskState(work.taskId);
  expect(before).toMatchObject([
    {
      task: expect.any(String),
      versions: expect.any(String),
      history: expect.stringContaining('task.pickup:applied'),
      events: 'claimed,dropped,reactivated',
    },
  ]);
  // The plan and todo are the framework's own: none of it is in any product row.
  expect(await holding(canary)).toStrictEqual([]);
  framework.store.clear();
  expect(await taskState(work.taskId)).toStrictEqual(before);
  // The next step is the product's: the queue names it and a pickup takes the same run.
  const entry = await queued(work.taskId);
  const picked = appliedDetail(
    await asAgent(s, {
      command: 'task.pickup',
      ...fresh(),
      reservationId: entry?.['reservationId'],
    }),
    'task.pickup',
  );
  expect(picked['runId']).toBe(work.picked['runId']);
  expect(framework.store.size).toBe(0);
}

const fresh = (): { operationId: string } => ({ operationId: randomUUID() });

/** The framework's own resume from its checkpoint, with its token: pickup, beat, dispatch, decide. */
async function resumeFrom(work: Work, gate: Detail): Promise<readonly unknown[]> {
  const credential = String(work.picked['credential']);
  const lease = { leaseId: work.picked['leaseId'], fence: work.picked['fence'] };
  const reservationId = work.decision['reservationId'];
  return [
    await asAgent(s, { command: 'task.pickup', ...fresh(), reservationId }),
    // Its checkpoint names the successor's gate, and its version, as the work to pick up.
    await asAgent(s, { command: 'task.pickup', ...fresh(), reservationId: gate['gateId'] }),
    await asAgent(s, { command: 'task.pickup', ...fresh(), reservationId, ...gate }),
    await asAgent(s, { command: 'task.heartbeat', ...fresh(), ...lease }, credential),
    await asAgent(s, { command: 'task.dispatch', ...fresh(), ...lease }, credential),
    // Its settled credential would answer DELEGATION_NOT_LIVE; with none, it is the decision.
    await asAgent(s, { command: 'task.decide', ...fresh(), ...gate, decision: 'approve' }),
  ];
}

async function approvalAuthority(): Promise<void> {
  const work = await liveWork(s, `aw12 gate ${randomUUID()}`, 2_000);
  const framework = onBroker(work);
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
  const written = async (): Promise<readonly unknown[]> => [
    await handbackFootprint(s, work.picked['leaseId']),
    await rows(s, leases, [work.taskId]),
  ];
  const footprint = await written();

  const resumed = await resumeFrom(work, gate);
  expect(resumed).toMatchObject(
    [
      'RESERVATION_NOT_CLAIMABLE',
      'RESERVATION_NOT_CLAIMABLE',
      'COMMAND_BODY_INVALID',
      'DELEGATION_NOT_LIVE',
      'DELEGATION_NOT_LIVE',
      'DELEGATION_EXCLUDES_DECISION',
    ].map((code) => ({
      refused: true,
      code,
    })),
  );
  expect(await queued(work.taskId)).toBeUndefined();
  // Nothing written: no lease, reservation, gate or version moved.
  expect(await written()).toStrictEqual(footprint);

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
  const work = await liveWork(s, `aw12 retry ${randomUUID()}`, 2_000);
  const framework = onBroker(work, 2);
  const reservations = `select count(*)::text as n from public.reservations res
      join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
      where res.business_id = $1 and run.task_id = $2`;
  const [held] = await rows<{ n: string }>(s, reservations, [s.business, work.taskId]);
  const before = await attempts(s, work.taskId);
  const seen = world.provider.seen.length;

  // The provider is down: the framework's own policy tries twice more, through the broker.
  world.provider.mode('unavailable');
  const { calls, last } = await framework.step('Draft the copy correction.');
  world.provider.mode('answer');
  expect(calls).toBe(3);
  expect(world.provider.seen.length - seen).toBe(1);
  expect(last).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN' });
  expect(await callsOn(work)).toMatchObject([
    { state: 'liability_unknown', sent: true },
    { state: 'refused', refusal_code: 'LIABILITY_UNKNOWN', sent: false },
    { state: 'refused', refusal_code: 'LIABILITY_UNKNOWN', sent: false },
  ]);

  // The product owns the retry: the hand-back (again, it replays) and the pass's proof.
  const drop = dropBody(work);
  appliedDetail(await asAgent(s, drop, String(work.picked['credential'])), 'task.handback');
  appliedDetail(await asAgent(s, drop, String(work.picked['credential'])), 'task.handback');
  expect(await attempts(s, work.taskId)).toMatchObject([{ state: 'liability_unknown' }]);
  await room(s, work);
  world.provider.lookupMode('honest');
  await pass(s);
  const after = await attempts(s, work.taskId);
  const [heldAfter] = await rows<{ n: string }>(s, reservations, [s.business, work.taskId]);
  expect(after.slice(before.length)).toMatchObject([{ state: 'reserved', held: 'held' }]);
  expect(Number(heldAfter?.n) - Number(held?.n)).toBe(1);
}

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
      "A1 task authority: with the framework's store gone, the run resumes from the product's rows alone",
      taskAuthority,
    );
    it(
      "A2 approval authority: a framework's own resume cannot resume a run without a product gate decision",
      approvalAuthority,
    );
    it(
      'A7: a framework retry through the broker after a failed call is refused, nothing sent',
      retryOwner,
    );
    it(
      "A8 state transitions: the run record cannot be updated from the harness's database role",
      stateTransitions,
    );
  },
);
