// SPDX-License-Identifier: AGPL-3.0-only
//
// Data separation inside one business for a task's carried call (#1703,
// #1620 P5): a task linked to a client is never carried, and its refusal
// names no client; another agent of the business, presenting its own token
// for the lease holder's call, is refused at the offer and cannot join the
// call's line; a carrier that carries for another person does not carry this
// owner's run. Each is refused before any send, nothing offered.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callTopic } from '../../packages/core-custody/src/index.ts';
import type { BusinessId, VerifiedSubject } from '../../packages/core-records/src/index.ts';
import { tokenFor } from '../api/fixture.ts';
import { insertAgentActor, insertAgentMapping, insertLogin } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { liveWork, type Work } from '../runtime/schedules-harness.ts';
import { s, useBrokerWorld } from './broker-world.ts';
import { carriedCall, openCarriedTaskWorld, type CarriedTaskWorld } from './carried-task-world.ts';

const serverUrl = databaseUrlFromEnvironment();

useBrokerWorld('carrysep');

const fresh = async (title: string): Promise<Work> =>
  await liveWork(s, `${title} ${randomUUID()}`, 2_000);

const offeredOn = async (work: Work): Promise<number> => {
  const [row] = await s.db.admin.execute<{ readonly n: string }>(
    `select count(*)::text as n from public.model_call_carriers k
       join public.model_calls c on c.business_id = k.business_id and c.id = k.call_id
      where c.lease_id = $1 and k.offered_at is not null`,
    [work.picked['leaseId']],
  );
  return Number(row?.n);
};

// oxlint-disable-next-line max-lines-per-function -- one world, four crossings
describe.skipIf(serverUrl === undefined)('a carried task call, inside one business', () => {
  let world: CarriedTaskWorld;
  let otherSub: string;

  beforeAll(async () => {
    world = await openCarriedTaskWorld();
    otherSub = `other-agent-${randomUUID()}`;
    await s.db.app.withBusiness(s.business, async (tx) => {
      const actor = await insertAgentActor(tx);
      await insertAgentMapping(tx, await insertLogin(tx, otherSub), actor, s.decider.actorId);
    });
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  it("never carries a client's task, and its refusal names no client", async () => {
    const work = await fresh('Client task');
    const client = randomUUID();
    await s.db.admin.execute(
      `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
      [work.taskId, client],
    );
    const sent = world.plan.sent.length;
    const answer = await carriedCall(world, work);
    expect(answer).toMatchObject({ ok: false });
    expect(JSON.stringify(answer)).not.toContain(client);
    expect(world.plan.sent).toHaveLength(sent);
    expect(await offeredOn(work)).toBe(0);
  }, 60_000);

  it("refuses another agent of the business presenting its own token for the holder's call", async () => {
    const work = await fresh('Another agent at the offer');
    const presented: VerifiedSubject = {
      ...world.presented,
      subject: otherSub,
      sessionId: randomUUID(),
    };
    const crossed = { ...world, presented, token: await tokenFor(otherSub) };
    const sent = world.plan.sent.length;
    const answer = await carriedCall(crossed, work);
    expect(answer).toMatchObject({ ok: false, code: 'AUTHORITY_LOST' });
    expect(world.plan.sent).toHaveLength(sent);
    expect(await offeredOn(work)).toBe(0);
  }, 60_000);

  it("lets another agent of the business not join the holder's call line", async () => {
    const work = await fresh('Another agent at the line');
    const joins: Record<string, boolean> = {};
    world.duringPrepare = async () => {
      const [call] = await s.db.admin.execute<{ readonly id: string }>(
        `select id from public.model_calls where lease_id = $1 and state = 'dispatched'`,
        [work.picked['leaseId']],
      );
      const topic = callTopic(s.business as BusinessId, String(call?.id));
      for (const [who, sub] of [
        ['other agent', otherSub],
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

  it('does not carry the run of a person the carrier does not carry for', async () => {
    const work = await fresh('Carrier for another person');
    const { carrier } = world.broker;
    if (carrier === undefined) throw new Error('the world carries');
    const on = { ...world.broker, carrier: { ...carrier, people: [randomUUID()] } };
    const sent = world.plan.sent.length;
    const answer = await carriedCall(world, work, on);
    expect(answer).toMatchObject({ ok: false, code: 'AUTHORITY_LOST' });
    expect(world.plan.sent).toHaveLength(sent);
    expect(await offeredOn(work)).toBe(0);
  }, 60_000);
});
