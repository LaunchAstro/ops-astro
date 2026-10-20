// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's call carried to the M5 (#1703, #1620 P5, criterion 1): an
// owner-started internal task's call, made by the agent holding its lease,
// is offered on the hub with the agent's own token, accepted by the model
// agent, fenced, and sent by custody on the M5 to the plan's route, settled
// as a subscription. The hosted side never holds the plan's token: neither
// half of the live pair is in any message it sent or heard, in its answer,
// or in the business's rows. Without the handoff nothing is carried.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import { ACCESS, REFRESH } from '../custody/fixtures/plan-answer-world.ts';
import { rowsOf, s, useBrokerWorld } from './broker-world.ts';
import { carriedCall, openCarriedTaskWorld, type CarriedTaskWorld } from './carried-task-world.ts';

const serverUrl = databaseUrlFromEnvironment();

useBrokerWorld('carrytask');

/** The business's rows a hosted function writes or reads for a call, as text. */
async function hostedRows(): Promise<string> {
  const tables = ['model_calls', 'model_call_carriers', 'audit_events', 'operations'];
  const all = await Promise.all(
    tables.map(
      async (table) =>
        await s.db.admin.execute(`select to_jsonb(t)::text as row from public.${table} t`),
    ),
  );
  return JSON.stringify(all);
}

describe.skipIf(serverUrl === undefined)('a task call carried to the M5', () => {
  let world: CarriedTaskWorld;

  beforeAll(async () => {
    world = await openCarriedTaskWorld();
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  it("reaches the plan's route for an owner-started internal task, settled as a subscription", async () => {
    const work = await liveWork(s, `About page hours ${randomUUID()}`, 2_000);
    const sent = world.plan.sent.length;
    const answer = await carriedCall(world, work);
    expect(answer).toMatchObject({ ok: true, text: 'Weekdays 8 to 5.' });
    expect(world.plan.sent).toHaveLength(sent + 1);
    const [row] = await rowsOf(answer.callId);
    expect(row).toMatchObject({
      state: 'settled',
      route_key: 'chatgpt_plan',
      credential_kind: 'subscription',
    });
    const [carriers] = await s.db.admin.execute<{ readonly all: boolean }>(
      `select offered_at is not null and runner is not null and request_at is not null as all
         from public.model_call_carriers where call_id = $1`,
      [answer.callId],
    );
    expect(carriers).toEqual({ all: true });
  }, 60_000);

  it('holds no plan token on the hosted side: not in what it carried, its answer or its rows', async () => {
    const work = await liveWork(s, `Opening hours ${randomUUID()}`, 2_000);
    const answer = await carriedCall(world, work);
    expect(answer).toMatchObject({ ok: true });
    expect(world.carried.length).toBeGreaterThan(0);
    const hosted = [...world.carried, JSON.stringify(answer), await hostedRows()].join('\n');
    expect(hosted.includes(ACCESS)).toBe(false);
    expect(hosted.includes(REFRESH)).toBe(false);
  }, 60_000);

  it('control: without the handoff the call is not carried, and nothing is sent', async () => {
    const work = await liveWork(s, `Uncarried ${randomUUID()}`, 2_000);
    const sent = world.plan.sent.length;
    const { carrier: _carrier, ...uncarried } = world.broker;
    const answer = await carriedCall(world, work, uncarried);
    expect(answer).toMatchObject({ ok: false });
    expect(world.plan.sent).toHaveLength(sent);
  }, 60_000);
});
