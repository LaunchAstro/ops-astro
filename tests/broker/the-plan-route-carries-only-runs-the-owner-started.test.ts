// SPDX-License-Identifier: AGPL-3.0-only
//
// The `chatgpt-plan` route through the real broker and custody (#1620 P4),
// the replay provider standing in for the M5's answer: a run nobody attends
// reaches the owner's plan when the owner started its task, and the call
// records `credential_kind = subscription`. A run on a task staff started is
// refused `SUBSCRIPTION_NOT_OWNER_STARTED` before any route, recorded so,
// with nothing sent; a client's task keeps its own refusal. Another
// subscription route still refuses a run nobody attends.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  catalogue,
  CHATGPT_PLAN_PROVIDER,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import { callModel, type Broker, type BrokerRoute } from '../../packages/core-custody/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { liveWork, type Work } from '../runtime/schedules-harness.ts';
import {
  CLOUD,
  broker,
  caller,
  requestFor,
  rowsOf,
  s,
  stepOf,
  useBrokerWorld,
  world,
} from './broker-world.ts';

const serverUrl = databaseUrlFromEnvironment();

useBrokerWorld('planroute');

/** A compose operation on the plan's provider; the replay adapter builds its request. */
const PLAN_COMPOSE = {
  ...REPLAY_COMPOSE,
  key: 'model.plan_compose',
  provider: CHATGPT_PLAN_PROVIDER,
};

const PLAN: BrokerRoute = {
  ...CLOUD,
  key: 'chatgpt_plan',
  provider: CHATGPT_PLAN_PROVIDER,
  credentialKind: 'subscription',
};

/** Another subscription route on the same operation's provider, not the plan's. */
const SEAT: BrokerRoute = { ...CLOUD, key: 'owners_seat', credentialKind: 'subscription' };

const onPlan = (): Broker => ({
  ...broker,
  operations: catalogue([REPLAY_COMPOSE, PLAN_COMPOSE]),
  providers: new Map([
    ['replay', { build: replayAdapter, price: replayCostMinor }],
    [CHATGPT_PLAN_PROVIDER, { build: replayAdapter, price: replayCostMinor }],
  ]),
  routes: [PLAN],
});

/** The world's person, who creates every task here, holding `role` from now on. */
async function holdsRole(role: 'owner' | 'member'): Promise<void> {
  await s.db.admin.execute(
    `update public.memberships set active = false, ended_at = clock_timestamp()
      where business_id = $1 and person_id = $2 and active`,
    [s.business, s.decider.personId],
  );
  await s.db.admin.execute(
    `insert into public.memberships (business_id, id, person_id, role_key, active, joined_at)
     values ($1, $2, $3, $4, true, clock_timestamp())`,
    [s.business, randomUUID(), s.decider.personId, role],
  );
}

/** A live task created by a person holding `role`, picked up. */
async function startedBy(role: 'owner' | 'member', title: string): Promise<Work> {
  await holdsRole(role);
  return await liveWork(s, `${title} ${randomUUID()}`, 2_000);
}

/** The run's call on the plan, nobody attending it. */
async function ask(work: Work, on: Broker = onPlan()) {
  await stepOf(work);
  const request = requestFor(work, {
    operation: PLAN_COMPOSE.key,
    fields: [{ name: 'instruction', from: { recordId: work.taskId, key: 'title' } }],
  });
  return await callModel(s.db.app, s.business, caller(work), request, on);
}

async function recorded(callId: string | null) {
  const rows = await rowsOf(callId);
  return rows.map((row) => ({
    state: row['state'],
    route_key: row['route_key'],
    credential_kind: row['credential_kind'],
    refusal_code: row['refusal_code'],
  }));
}

describe.skipIf(serverUrl === undefined)('the plan route', () => {
  it('carries a run the owner started, nobody attending, recorded as a subscription', async () => {
    const work = await startedBy('owner', 'About page hours');
    const seen = world.provider.seen.length;
    const answer = await ask(work);
    expect(answer).toMatchObject({ ok: true });
    expect(await recorded(answer.callId)).toEqual([
      {
        state: 'settled',
        route_key: 'chatgpt_plan',
        credential_kind: 'subscription',
        refusal_code: null,
      },
    ]);
    expect(world.provider.seen.length).toBe(seen + 1);
  }, 120_000);

  it('refuses a run on a task staff started, by name, with nothing sent', async () => {
    const work = await startedBy('member', 'Staff task');
    const seen = world.provider.seen.length;
    const answer = await ask(work);
    expect(answer).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' });
    expect(await recorded(answer.callId)).toEqual([
      {
        state: 'refused',
        route_key: null,
        credential_kind: null,
        refusal_code: 'SUBSCRIPTION_NOT_OWNER_STARTED',
      },
    ]);
    expect(world.provider.seen.length).toBe(seen);
  }, 120_000);
});

describe.skipIf(serverUrl === undefined)('the plan route, staff and clients', () => {
  it('keeps refusing a staff-started task after its creator becomes the owner', async () => {
    const work = await startedBy('member', 'Staff task, then owner');
    await holdsRole('owner');
    const seen = world.provider.seen.length;
    expect(await ask(work)).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' });
    expect(world.provider.seen.length).toBe(seen);
  }, 120_000);

  it("refuses an owner's task with a client as client work, with nothing sent", async () => {
    const work = await startedBy('owner', 'Client task');
    await s.db.admin.execute(
      `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
      [work.taskId, randomUUID()],
    );
    const seen = world.provider.seen.length;
    expect(await ask(work)).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK' });
    expect(world.provider.seen.length).toBe(seen);
  }, 120_000);

  it('control: another subscription route still refuses a run nobody attends', async () => {
    const work = await startedBy('owner', 'Owner task, other seat');
    await stepOf(work);
    const seen = world.provider.seen.length;
    const answer = await callModel(
      s.db.app,
      s.business,
      caller(work),
      requestFor(work, {
        fields: [{ name: 'instruction', from: { recordId: work.taskId, key: 'title' } }],
      }),
      { ...broker, routes: [SEAT] },
    );
    expect(answer).toMatchObject({ ok: false, code: 'SUBSCRIPTION_UNATTENDED' });
    expect(world.provider.seen.length).toBe(seen);
  }, 120_000);
});
