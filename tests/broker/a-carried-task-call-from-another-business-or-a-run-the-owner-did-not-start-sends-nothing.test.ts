// SPDX-License-Identifier: AGPL-3.0-only
//
// Who a task's carried call is for (#1703, #1620 P5, criterion 3): only a run
// the owner started, in the carrier's own business. A run staff queued on a
// task the owner created is refused `SUBSCRIPTION_NOT_OWNER_STARTED`: the
// starter is the run's, not the task's creator. Another business's run, even
// one its owner started, is never carried by this business's model agent,
// and that business's agent can neither use this business's lease nor join
// this business's call. Each is refused before any send, nothing offered.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callTopic,
  reserveModelCall,
  sendReservedCall,
  type ModelCaller,
} from '../../packages/core-custody/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { auditAs } from '../../packages/core-commands/src/commands/model-call.ts';
import { taskHandoff } from '../../packages/core-commands/src/commands/task-carriage.ts';
import { tokenFor } from '../api/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  approve,
  createTask,
  freshPurpose,
  liveWork,
  pickup,
  propose,
  seedSchedules,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import { requestFor, s, stepOf, useBrokerWorld } from './broker-world.ts';
import {
  carriedCall,
  holdsRole,
  openCarriedTaskWorld,
  PLAN_TASK,
  type CarriedTaskWorld,
} from './carried-task-world.ts';

const serverUrl = databaseUrlFromEnvironment();

useBrokerWorld('carrywho');

const offeredOn = async (work: Work): Promise<number> => {
  const [row] = await s.db.admin.execute<{ readonly n: string }>(
    `select count(*)::text as n from public.model_call_carriers k
       join public.model_calls c on c.business_id = k.business_id and c.id = k.call_id
      where c.lease_id = $1 and k.offered_at is not null`,
    [work.picked['leaseId']],
  );
  return Number(row?.n);
};

const planAsk = (work: Work) =>
  requestFor(work, {
    operation: PLAN_TASK.key,
    fields: [{ name: 'instruction', from: { recordId: work.taskId, key: 'title' } }],
  });

// oxlint-disable-next-line max-lines-per-function -- two businesses, one world
describe.skipIf(serverUrl === undefined)('a carried task call, by whose run it is', () => {
  let world: CarriedTaskWorld;
  let other: Schedules;

  beforeAll(async () => {
    world = await openCarriedTaskWorld();
    other = await seedSchedules(s.db, 'carrywho_other', 1_000_000);
    await holdsRole('owner', other);
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  it("refuses a run staff queued on the owner's task, nothing offered or sent", async () => {
    await holdsRole('owner');
    const taskId = await createTask(s, `Owner's task ${randomUUID()}`);
    await holdsRole('member');
    const proposal = await propose(s, taskId, { maximumMinor: 2_000, purpose: freshPurpose() });
    const decision = await approve(s, proposal);
    const picked = await pickup(s, decision['reservationId']);
    await holdsRole('owner');
    const work: Work = { taskId, proposal, decision, picked };
    const sent = world.plan.sent.length;
    const answer = await carriedCall(world, work);
    expect(answer).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' });
    expect(world.plan.sent).toHaveLength(sent);
    expect(await offeredOn(work)).toBe(0);
  }, 60_000);

  it("never carries another business's run, even one its owner started", async () => {
    const work = await liveWork(other, `Other business ${randomUUID()}`, 2_000);
    await stepOf(work);
    const request = planAsk(work);
    const asking: ModelCaller = {
      actorId: other.agentActorId,
      delegationId: String(work.picked['delegationId']),
      attendedByPersonId: null,
    };
    // Its events are its own agent's, in its own business.
    const on = { ...world.broker, audit: auditAs(other.agentActorId) };
    const reserving = await s.db.app.withBusiness(
      other.business,
      async (tx) => await reserveModelCall(tx, asking, request, on),
    );
    if (!reserving.ok) throw new Error(`the hold was refused: ${reserving.code}`);
    const { carrier } = world.broker;
    if (carrier === undefined) throw new Error('the world carries');
    const sent = world.plan.sent.length;
    const token = await tokenFor(other.agent.subject);
    const answer = await sendReservedCall(
      s.db.app,
      other.business,
      asking,
      request,
      reserving.reserved,
      on,
      taskHandoff(s.db.app, other.business, other.agent, token, {
        caller: asking,
        request,
        carrier,
        broker: on,
        timeoutMs: PLAN_TASK.timeoutMs,
      }),
    );
    expect(answer).toMatchObject({ ok: false, code: 'CARRIAGE_UNAVAILABLE' });
    expect(world.plan.sent).toHaveLength(sent);
    expect(await offeredOn(work)).toBe(0);
  }, 60_000);

  it("lets another business's agent neither use this business's lease nor join its call", async () => {
    const work = await liveWork(s, `This business ${randomUUID()}`, 2_000);
    await stepOf(work);
    const asking: ModelCaller = {
      actorId: other.agentActorId,
      delegationId: String(work.picked['delegationId']),
      attendedByPersonId: null,
    };
    const crossed = await s.db.app.withBusiness(
      other.business,
      async (tx) => await reserveModelCall(tx, asking, planAsk(work), world.broker),
    );
    expect(crossed).toMatchObject({ ok: false, code: 'LEASE_NOT_OWNED' });
    const joins: Record<string, boolean> = {};
    world.duringPrepare = async () => {
      const [call] = await s.db.admin.execute<{ readonly id: string }>(
        `select id from public.model_calls where lease_id = $1 and state = 'dispatched'`,
        [work.picked['leaseId']],
      );
      const topic = callTopic(s.business as BusinessId, String(call?.id));
      for (const [who, sub] of [
        ['other agent', other.agent.subject],
        ['holder', s.agent.subject],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one join at a time
        const joined = await world.hub.join(topic, { sub });
        joins[who] = joined !== 'refused';
        if (joined !== 'refused') joined.leave();
      }
    };
    try {
      expect(await carriedCall(world, work)).toMatchObject({ ok: true });
    } finally {
      world.duringPrepare = async () => {};
    }
    expect(joins).toEqual({ 'other agent': false, holder: true });
  }, 60_000);
});
