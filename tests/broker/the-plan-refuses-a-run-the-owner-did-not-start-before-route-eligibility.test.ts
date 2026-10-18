// SPDX-License-Identifier: AGPL-3.0-only
//
// The `chatgpt-plan` route's owner-start refusal through the real broker and
// custody (#1620 P4): a run on a task staff created is refused
// `SUBSCRIPTION_NOT_OWNER_STARTED` before the data classes choose a route,
// with nothing sent; and a run a member proposes and approves on a task the
// owner created is refused too, since the owner did not start that run.
// Who started the run is the standing the database stamped on its proposal
// and approvals as they were written (#1909): no later application write to
// membership history, and no value the application supplies, makes a
// member's run read as the owner's.

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
import { hold, waiterOf } from '../support/lock-wait-race.ts';
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

/**
 * A proposal by the world's person, an owner, made while a transaction of its
 * own ends that owner membership for a member one: the proposal is seen
 * waiting on the demotion before it commits.
 */
async function proposedDuringDemotion(): Promise<Awaited<ReturnType<typeof propose>>> {
  await holdsRole('owner');
  const taskId = await createTask(s, `owner task ${randomUUID()}`);
  const demoted = await hold(s.db, async (execute) => {
    await execute(
      `update public.memberships set active = false, ended_at = clock_timestamp()
        where business_id = $1 and person_id = $2 and active`,
      [s.business, s.decider.personId],
    );
    await execute(
      `insert into public.memberships (business_id, id, person_id, role_key, active, joined_at)
         values ($1, $2, $3, 'member', true, clock_timestamp())`,
      [s.business, randomUUID(), s.decider.personId],
    );
  });
  try {
    const proposing = propose(s, taskId, { maximumMinor: 2000, purpose: freshPurpose() });
    await waiterOf(s.db, demoted);
    await demoted.letGo();
    return await proposing;
  } finally {
    await demoted.letGo();
  }
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
    expect(answer).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' });
    expect(await rowsOf(answer.callId)).toMatchObject([
      {
        state: 'refused',
        reserved_minor: '0',
        refusal_code: 'SUBSCRIPTION_NOT_OWNER_STARTED',
        route_key: null,
        credential_kind: null,
      },
    ]);
  }, 120_000);
});

describe.skipIf(serverUrl === undefined)('application writes after the run started', () => {
  it('application writes cannot backfill owner standing over a member-started run', async () => {
    await holdsRole('owner');
    const taskId = await createTask(s, `owner task ${randomUUID()}`);
    await holdsRole('member');
    const proposal = await propose(s, taskId, { maximumMinor: 2000, purpose: freshPurpose() });
    const decision = await approve(s, proposal);
    const picked = await pickup(s, decision['reservationId']);
    const work = { taskId, proposal, decision, picked };
    expect(await ask(work)).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' });
    // Real application credentials, no administrator, trigger changes or disabled RLS.
    // Insert an ended historical owner membership covering the run's two events.
    await s.db.app.withBusiness(s.business, async (tx) => {
      await tx.query(
        `insert into public.memberships
        (business_id,id,person_id,role_key,active,joined_at,ended_at)
        select $1,$2,$3,'owner',false,v.created_at - interval '1 second',clock_timestamp()
        from public.proposal_versions v where v.business_id = $1 and v.id = $4`,
        [s.business, randomUUID(), s.decider.personId, proposal['versionId']],
      );
    });
    const seen = world.provider.seen.length;
    const answer = await ask(work);
    expect.soft(world.provider.seen.length).toBe(seen);
    expect(answer).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' });
  }, 120_000);

  it('promoting a member to owner after their run started does not carry that run', async () => {
    await holdsRole('member');
    const work = await liveWork(s, `member's task ${randomUUID()}`, 2_000);
    expect(await ask(work)).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' });
    await s.db.app.withBusiness(s.business, async (tx) => {
      await tx.query(
        `update public.memberships set role_key = 'owner'
        where business_id = $1 and person_id = $2 and active`,
        [s.business, s.decider.personId],
      );
    });
    const seen = world.provider.seen.length;
    const answer = await ask(work);
    expect.soft(world.provider.seen.length).toBe(seen);
    expect(answer).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' });
    expect(await rowsOf(answer.callId)).toMatchObject([
      { state: 'refused', reserved_minor: '0', route_key: null, credential_kind: null },
    ]);
  }, 120_000);
});

describe.skipIf(serverUrl === undefined)('the standing the database records', () => {
  it("the application can neither supply nor edit the proposer's recorded standing", async () => {
    await holdsRole('member');
    const taskId = await createTask(s, `member's task ${randomUUID()}`);
    const proposal = await propose(s, taskId, { maximumMinor: 2000, purpose: freshPurpose() });
    const supplied = await s.db.app.withBusiness(
      s.business,
      async (tx) =>
        await tx.query<{ proposed_by_owner: boolean }>(
          `insert into public.proposal_versions
             (business_id, id, lineage_id, version, payload, payload_digest, purpose,
              maximum_minor, currency, proposed_by_actor_id, superseded_at, proposed_by_owner)
           select business_id, $3, lineage_id, version + 1000, payload, payload_digest, purpose,
                  maximum_minor, currency, proposed_by_actor_id, clock_timestamp(), true
             from public.proposal_versions where business_id = $1 and id = $2
           returning proposed_by_owner`,
          [s.business, proposal['versionId'], randomUUID()],
        ),
    );
    expect(supplied).toStrictEqual([{ proposed_by_owner: false }]);
    await expect(
      s.db.app.withBusiness(s.business, async (tx) => {
        await tx.query(
          `update public.proposal_versions set proposed_by_owner = true
            where business_id = $1 and id = $2`,
          [s.business, proposal['versionId']],
        );
      }),
    ).rejects.toThrow(/cannot be edited/u);
  }, 120_000);

  it("a proposal waiting on the owner's demotion records the standing after it", async () => {
    const proposal = await proposedDuringDemotion();
    const [stamp] = await s.db.admin.execute<{ proposed_by_owner: boolean }>(
      'select proposed_by_owner from public.proposal_versions where id = $1',
      [proposal['versionId']],
    );
    expect(stamp).toStrictEqual({ proposed_by_owner: false });
  }, 120_000);
});
