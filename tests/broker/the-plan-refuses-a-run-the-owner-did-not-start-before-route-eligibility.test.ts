// SPDX-License-Identifier: AGPL-3.0-only
//
// The `chatgpt-plan` route's owner-start refusal through the real broker and
// custody (#1620 P4): a run on a task staff created is refused
// `SUBSCRIPTION_NOT_OWNER_STARTED` before the data classes choose a route,
// with nothing sent; and a run a member proposes and approves on a task the
// owner created is refused too, since the owner did not start that run.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  catalogue,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import { callModel, type Broker, type BrokerRoute } from '../../packages/core-custody/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  createTask,
  propose,
  approve,
  pickup,
  freshPurpose,
  liveWork,
  type Work,
} from '../runtime/schedules-harness.ts';
import {
  CLOUD,
  broker,
  caller,
  requestFor,
  s,
  stepOf,
  useBrokerWorld,
  world,
} from './broker-world.ts';

const CHATGPT_PLAN_PROVIDER = 'chatgpt_plan';
const serverUrl = databaseUrlFromEnvironment();

useBrokerWorld('planstarter');

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

describe.skipIf(serverUrl === undefined)('the plan route and who started the run', () => {
  it('a run on a task staff created is refused by name before route eligibility', async () => {
    const work = await startedBy('member', 'staff-created task');
    const seen = world.provider.seen.length;
    const answer = await ask(work);
    expect(world.provider.seen.length).toBe(seen);
    expect(answer).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' });
  }, 120_000);

  it('a member starting a new run on an owner-created task cannot use the plan', async () => {
    await holdsRole('owner');
    const taskId = await createTask(s, `owner-created task ${randomUUID()}`);
    await holdsRole('member');
    const proposal = await propose(s, taskId, { maximumMinor: 2000, purpose: freshPurpose() });
    const decision = await approve(s, proposal);
    const picked = await pickup(s, decision['reservationId']);
    const seen = world.provider.seen.length;
    const answer = await ask({ taskId, proposal, decision, picked });
    expect.soft(world.provider.seen.length).toBe(seen);
    expect(answer).toMatchObject({ ok: false });
  }, 120_000);
});
