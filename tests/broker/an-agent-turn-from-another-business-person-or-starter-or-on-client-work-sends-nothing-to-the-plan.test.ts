// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's turn on the owner's ChatGPT plan, carried to the model agent
// (#2091, as #2009 proved for a task's fields): only the owner's own run on an
// internal task is carried and sent. Another business's run is never carried,
// and its agent cannot use this business's lease or join its call; a run for
// a person the carrier does not carry for, a run staff started on the owner's
// task, and the owner's own run on a client's task are each refused before
// any send, nothing offered. A marker task planted in another business, and
// one with a client here, appear in no result and no carried message.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_TURN_KEY } from '../../packages/core-connectors/src/index.ts';
import {
  callTopic,
  reserveModelCall,
  sendReservedCall,
  type ModelCaller,
  type ModelCallRequest,
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
  revisionOf,
  seedSchedules,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import { requestFor, rowsOnLease, s, stepOf, useBrokerWorld } from './broker-world.ts';
import { holdsRole, openCarriedTaskWorld, type CarriedTaskWorld } from './carried-task-world.ts';
import { carriedTurn, turnBrokerOf } from './carried-turn-world.ts';

const serverUrl = databaseUrlFromEnvironment();

useBrokerWorld('turnsep');

const offeredOn = async (work: Work): Promise<number> => {
  const [row] = await s.db.admin.execute<{ readonly n: string }>(
    `select count(*)::text as n from public.model_call_carriers k
       join public.model_calls c on c.business_id = k.business_id and c.id = k.call_id
      where c.lease_id = $1 and k.offered_at is not null`,
    [work.picked['leaseId']],
  );
  return Number(row?.n);
};

const callRow = async (callId: string | null): Promise<Record<string, unknown> | undefined> => {
  if (callId === null) return undefined;
  const [row] = await s.db.admin.execute<Record<string, unknown>>(
    `select state, refusal_code from public.model_calls where id = $1`,
    [callId],
  );
  return row;
};

/** The run's first turn on the plan, its one part the task at its revision now in `of`. */
const turnAsk = async (of: Schedules, work: Work): Promise<ModelCallRequest> => {
  await stepOf(work);
  const task = { ref: 'task', taskId: work.taskId, revision: await revisionOf(of, work.taskId) };
  return requestFor(work, {
    operation: AGENT_TURN_KEY,
    fields: [],
    turn: { turnOrdinal: 0, tools: [], parts: [task] },
  });
};

// oxlint-disable-next-line max-lines-per-function -- two businesses, one world, four crossings
describe.skipIf(serverUrl === undefined)("an agent's carried turn on the plan", () => {
  let world: CarriedTaskWorld;
  let other: Schedules;
  let markers: readonly string[];

  /** No marker in any serialised result, any message carried so far, or anything the plan heard. */
  const leaksNothing = (...results: readonly unknown[]): void => {
    const seen = [
      ...results.map((result) => JSON.stringify(result)),
      ...world.carried,
      ...world.plan.sent.map((sent) => sent.raw),
    ].join('\n');
    for (const marker of markers) expect(seen).not.toContain(marker);
  };

  beforeAll(async () => {
    world = await openCarriedTaskWorld();
    other = await seedSchedules(s.db, 'turnsep_other', 1_000_000);
    await holdsRole('owner', other);
    const elsewhere = `marker-${randomUUID()}`;
    const clientHere = `marker-${randomUUID()}`;
    const client = randomUUID();
    const elsewhereId = await createTask(other, elsewhere);
    const clientHereId = await createTask(s, clientHere);
    await s.db.admin.execute(
      `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
      [clientHereId, client],
    );
    markers = [elsewhere, elsewhereId, clientHere, clientHereId, client];
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  it("never carries another business's turn, and its agent cannot use this business's lease", async () => {
    const theirs = await liveWork(other, `Other business ${randomUUID()}`, 2_000);
    const request = await turnAsk(other, theirs);
    const asking: ModelCaller = {
      actorId: other.agentActorId,
      delegationId: String(theirs.picked['delegationId']),
      attendedByPersonId: null,
    };
    // Its events are its own agent's, in its own business.
    const on = { ...turnBrokerOf(world), audit: auditAs(other.agentActorId) };
    const reserving = await s.db.app.withBusiness(
      other.business,
      async (tx) => await reserveModelCall(tx, asking, request, on),
    );
    if (!reserving.ok) throw new Error(`the hold was refused: ${reserving.code}`);
    const { carrier } = world.broker;
    if (carrier === undefined) throw new Error('the world carries');
    const sent = world.plan.sent.length;
    const answer = await sendReservedCall(
      s.db.app,
      other.business,
      asking,
      request,
      reserving.reserved,
      on,
      taskHandoff(s.db.app, other.business, other.agent, await tokenFor(other.agent.subject), {
        caller: asking,
        request,
        carrier,
        broker: on,
        timeoutMs: reserving.reserved.operation.timeoutMs,
      }),
    );
    expect(answer).toMatchObject({ ok: false, code: 'CARRIAGE_UNAVAILABLE' });
    expect(await callRow(answer.callId)).toMatchObject({ state: 'released' });
    expect(world.plan.sent).toHaveLength(sent);
    expect(await offeredOn(theirs)).toBe(0);

    const ours = await liveWork(s, `This business ${randomUUID()}`, 2_000);
    const onOurs = await turnAsk(s, ours);
    const crossed = await s.db.app.withBusiness(
      other.business,
      async (tx) => await reserveModelCall(tx, asking, onOurs, turnBrokerOf(world)),
    );
    expect(crossed).toMatchObject({ ok: false, code: 'LEASE_NOT_OWNED', callId: null });
    expect(await rowsOnLease(ours)).toHaveLength(0);
    expect(world.plan.sent).toHaveLength(sent);
    expect(await offeredOn(ours)).toBe(0);
    leaksNothing(answer, crossed);
  }, 60_000);

  it('does not carry the turn of a person the carrier does not carry for', async () => {
    const work = await liveWork(s, `Carrier for another person ${randomUUID()}`, 2_000);
    const base = turnBrokerOf(world);
    const { carrier } = base;
    if (carrier === undefined) throw new Error('the world carries');
    const on = { ...base, carrier: { ...carrier, people: [randomUUID()] } };
    const sent = world.plan.sent.length;
    const answer = await carriedTurn(world, work, on);
    expect(answer).toMatchObject({ ok: false, code: 'CALL_RELEASED', reason: 'AUTHORITY_LOST' });
    expect(await callRow(answer.callId)).toMatchObject({ state: 'released' });
    expect(world.plan.sent).toHaveLength(sent);
    expect(await offeredOn(work)).toBe(0);
    leaksNothing(answer);
  }, 60_000);

  it("refuses a turn on a run staff started on the owner's task, nothing offered or sent", async () => {
    await holdsRole('owner');
    const taskId = await createTask(s, `Owner's task ${randomUUID()}`);
    await holdsRole('member');
    const proposal = await propose(s, taskId, { maximumMinor: 2_000, purpose: freshPurpose() });
    const decision = await approve(s, proposal);
    const picked = await pickup(s, decision['reservationId']);
    await holdsRole('owner');
    const work: Work = { taskId, proposal, decision, picked };
    const sent = world.plan.sent.length;
    const answer = await carriedTurn(world, work);
    expect(answer).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' });
    expect(await callRow(answer.callId)).toEqual({
      state: 'refused',
      refusal_code: 'SUBSCRIPTION_NOT_OWNER_STARTED',
    });
    expect(world.plan.sent).toHaveLength(sent);
    expect(await offeredOn(work)).toBe(0);
    leaksNothing(answer);
  }, 60_000);

  it("never carries the owner's turn on a client's task, and its refusal names no client", async () => {
    const work = await liveWork(s, `Client task ${randomUUID()}`, 2_000);
    const client = randomUUID();
    await s.db.admin.execute(
      `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
      [work.taskId, client],
    );
    const sent = world.plan.sent.length;
    const answer = await carriedTurn(world, work);
    expect(answer).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK' });
    expect(JSON.stringify(answer)).not.toContain(client);
    expect(await callRow(answer.callId)).toEqual({
      state: 'refused',
      refusal_code: 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK',
    });
    expect(world.plan.sent).toHaveLength(sent);
    expect(await offeredOn(work)).toBe(0);
    leaksNothing(answer);
  }, 60_000);

  it("carries and sends the owner's own turn on an internal task, which no other business's agent joins", async () => {
    const work = await liveWork(s, `Internal task ${randomUUID()}`, 2_000);
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
    const sent = world.plan.sent.length;
    const answer = await carriedTurn(world, work).finally(() => {
      world.duringPrepare = async () => {};
    });
    expect(answer).toMatchObject({ ok: true });
    expect(world.plan.sent).toHaveLength(sent + 1);
    expect(await callRow(answer.callId)).toMatchObject({ state: 'settled' });
    expect(joins).toEqual({ 'other agent': false, holder: true });
    leaksNothing(answer);
  }, 60_000);
});
