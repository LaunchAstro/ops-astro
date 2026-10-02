// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01's conversation seam (ORCH35 option a): a person's model call from
// their own conversation, local routes only and unpriced. The row carries the
// conversation and no task fact; a cloud route is refused before anything is
// written (AW-03 egress off); another business's conversation, another
// person's, and an agent under a live delegation are each refused with
// nothing written and nothing sent. The conversation's own rows (and the
// client crossing on them) are SL12's and join at the batch 3 join.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import {
  callModelInConversation,
  sweepModelCalls,
  type Broker,
  type ConversationCallRequest,
  type ModelCaller,
  type ModelCallResult,
} from '../../packages/core-custody/src/index.ts';
import { REPLAY_COMPOSE, replayAdapter } from '../../packages/core-connectors/src/index.ts';
import { enrol, type Member } from '../commands/fixture.ts';
import {
  liveWork,
  seedSchedules,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import {
  CLOUD,
  LOCAL,
  PLANTED_PROMPT,
  broker,
  callCount,
  noDatabase,
  s,
  useBrokerWorld,
  withRoutes,
  world,
} from './broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw01conv');

let other: Member;
let bravo: Schedules;
/** A pickup's live delegation: the agent acts under it for the owner. */
let work: Work;

beforeAll(async () => {
  if (noDatabase) return;
  other = await enrol(s.db.app, s.business, 'other-person');
  bravo = await seedSchedules(s.db, 'aw01conv-bravo', 1_000_000);
  work = await liveWork(s, `aw01conv-${randomUUID()}`, 2_000);
}, 180_000);

/** The owner in their own session, no delegation. */
const person = (): ModelCaller => ({
  actorId: s.decider.actorId,
  delegationId: null,
  attendedByPersonId: s.decider.personId,
});

const ask = (overrides: Partial<ConversationCallRequest['conversation']> = {}) =>
  ({
    conversation: {
      id: randomUUID(),
      businessId: s.business,
      ownerPersonId: s.decider.personId,
      ...overrides,
    },
    operation: REPLAY_COMPOSE.key,
    fields: [{ name: 'message', source: 'outside', value: PLANTED_PROMPT }],
  }) satisfies ConversationCallRequest;

/** A local model: the replay provider on the local route, priced at nothing. */
const local = (): Broker => ({
  ...withRoutes([LOCAL]),
  providers: new Map([['replay', { build: replayAdapter, price: () => 0 }]]),
});

const inConversation = async (
  caller: ModelCaller,
  request: ConversationCallRequest,
  with_: Broker = local(),
): Promise<ModelCallResult> =>
  await callModelInConversation(s.db.app, s.business, caller, request, with_);

const rowsFor = async (conversationId: string): Promise<readonly Record<string, unknown>[]> =>
  await s.db.admin.execute(`select * from public.model_calls where conversation_id = $1`, [
    conversationId,
  ]);

it('AW-01 conversation call: the owner calls a local route, nothing reserved, the row names the conversation and no task fact', async () => {
  const request = ask();
  const result = await inConversation(person(), request);
  expect(result).toMatchObject({ ok: true, reservedMinor: 0, actualMinor: 0, releasedMinor: 0 });
  const [row, ...more] = await rowsFor(request.conversation.id);
  expect(more).toEqual([]);
  expect(row).toMatchObject({
    business_id: s.business,
    conversation_id: request.conversation.id,
    run_id: null,
    step_id: null,
    lease_id: null,
    version_id: null,
    reservation_id: null,
    delegation_id: null,
    route_reach: 'local',
    reserved_minor: '0',
    state: 'settled',
  });
});

it('AW-01 conversation call: a priced answer is above a hold of nothing, so it is held for a person, never settled', async () => {
  const request = ask();
  const result = await inConversation(person(), request, withRoutes([LOCAL]));
  expect(result).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN', heldMinor: 0 });
  const [row] = await rowsFor(request.conversation.id);
  expect(row).toMatchObject({
    state: 'liability_unknown',
    reserved_minor: '0',
    actual_minor: null,
  });
  expect(Number(row?.['observed_minor'])).toBeGreaterThan(0);
});

it('AW-01 conversation egress off: a cloud route from a conversation is refused before any row or request', async () => {
  const request = ask();
  const before = await callCount();
  const sent = world.provider.seen.length;
  const result = await inConversation(person(), request, withRoutes([CLOUD]));
  expect(result).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED', callId: null });
  expect(JSON.stringify(result)).not.toContain(PLANTED_PROMPT);
  expect(await callCount()).toBe(before);
  expect(world.provider.seen.length).toBe(sent);
  // With no field for the data classes to keep local, only the conversation's
  // own rule stands between it and the cloud route.
  const bare = { ...ask(), fields: [] };
  expect(await inConversation(person(), bare, withRoutes([CLOUD]))).toMatchObject({
    ok: false,
    code: 'LOCAL_MODEL_REQUIRED',
    callId: null,
  });
  expect(await rowsFor(bare.conversation.id)).toEqual([]);
  expect(world.provider.seen.length).toBe(sent);
  // The default broker (cloud only) refuses the same way.
  expect(await inConversation(person(), ask(), broker)).toMatchObject({
    ok: false,
    code: 'LOCAL_MODEL_REQUIRED',
  });
});

it('AW-01 conversation isolation: another business, another person, and an agent under a live delegation are refused, nothing written or sent', async () => {
  const crossings: [string, ModelCaller, ConversationCallRequest][] = [
    ['another business', person(), ask({ businessId: bravo.business })],
    ['another person', person(), ask({ ownerPersonId: other.personId })],
    [
      'another person in their own session',
      { actorId: other.actorId, delegationId: null, attendedByPersonId: other.personId },
      ask(),
    ],
    [
      'an agent under a live delegation',
      {
        actorId: s.agentActorId,
        delegationId: String(work.picked['delegationId']),
        attendedByPersonId: null,
      },
      ask(),
    ],
    [
      'the owner through a delegation',
      { ...person(), delegationId: String(work.picked['delegationId']) },
      ask(),
    ],
  ];
  for (const [crossing, caller, request] of crossings) {
    // Sequential: each crossing's counts are read before and after its own call.
    // eslint-disable-next-line no-await-in-loop
    const before = await callCount();
    const sent = world.provider.seen.length;
    // eslint-disable-next-line no-await-in-loop
    const result = await inConversation(caller, request);
    expect(result, crossing).toMatchObject({ ok: false, code: 'AUTHORITY_LOST', callId: null });
    const body = JSON.stringify(result);
    expect(body, crossing).not.toContain(request.conversation.id);
    expect(body, crossing).not.toContain(request.conversation.businessId);
    expect(body, crossing).not.toContain(PLANTED_PROMPT);
    // eslint-disable-next-line no-await-in-loop
    expect(await callCount(), crossing).toBe(before);
    expect(world.provider.seen.length, crossing).toBe(sent);
  }
});

it('AW-01 conversation sweep: a call left started past ten minutes is held, never left in flight; a fresh one is left', async () => {
  const [stale, fresh] = [randomUUID(), randomUUID()];
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const [conversationId, age] of [
      [stale, '11 minutes'],
      [fresh, '0 minutes'],
    ] as const) {
      // Sequential: two rows, one statement each.
      // eslint-disable-next-line no-await-in-loop
      await tx.query(
        `insert into public.model_calls
           (business_id, id, conversation_id, operation_key, state, reserved_minor,
            route_key, route_reach, credential_kind, accepted_at, started_at)
         values ($1, gen_random_uuid(), $2, 'model.replay_compose', 'dispatched', 0,
                 'on_premises', 'local', 'api_key',
                 clock_timestamp() - $3::interval, clock_timestamp() - $3::interval)`,
        [tx.businessId, conversationId, age],
      );
    }
  });
  const swept = await s.db.app.withBusiness(s.business, async (tx) => await sweepModelCalls(tx));
  expect(swept.held).toBe(1);
  expect(await rowsFor(stale)).toMatchObject([
    { state: 'liability_unknown', fault: 'ours', drop_state: 'dropped_no_answer' },
  ]);
  expect(await rowsFor(fresh)).toMatchObject([{ state: 'dispatched' }]);
});

it('AW-01 conversation scope: the database refuses a row with both scopes, with neither, or a conversation row that holds money or names a delegation', async () => {
  const [row] = await s.db.admin.execute<Record<string, string>>(
    `select run_id, step_id, lease_id, version_id, reservation_id
       from public.model_calls where business_id = $1 and run_id is not null limit 1`,
    [s.business],
  );
  const task = row ?? (await taskRow());
  expect(await insert({ ...task, conversation_id: randomUUID(), reserved_minor: 0 })).toBe(
    'model_calls_one_scope',
  );
  expect(await insert({ reserved_minor: 500 })).toBe('model_calls_one_scope');
  expect(await insert({ conversation_id: randomUUID(), reserved_minor: 500 })).toBe(
    'model_calls_one_scope',
  );
  expect(
    await insert({
      conversation_id: randomUUID(),
      reserved_minor: 0,
      delegation_id: String(work.picked['delegationId']),
    }),
  ).toBe('model_calls_one_scope');
});

/** A task call's five facts, from a real call on the world's live work. */
async function taskRow(): Promise<Record<string, string>> {
  const [row] = await s.db.admin.execute<Record<string, string>>(
    `select l.run_id, st.id as step_id, l.id as lease_id, r.version_id, r.id as reservation_id
       from public.leases l
       join public.reservations r on r.id = l.reservation_id
       join public.planned_steps st on st.run_id = l.run_id
      where l.id = $1 limit 1`,
    [work.picked['leaseId']],
  );
  if (row === undefined) throw new Error('no task facts');
  return row;
}

/** Inserts one call row as the application, naming the constraint that refused it. */
async function insert(values: Record<string, unknown>): Promise<string> {
  const columns = Object.keys(values);
  try {
    await s.db.app.withBusiness(s.business, async (tx) => {
      await tx.query(
        `insert into public.model_calls (business_id, id, operation_key, state, route_key,
           route_reach, credential_kind, ${columns.join(', ')})
         values ($1, gen_random_uuid(), 'model.replay_compose', 'dispatched', 'on_premises',
           'local', 'api_key', ${columns.map((_, n) => `$${String(n + 2)}`).join(', ')})`,
        [tx.businessId, ...Object.values(values)],
      );
    });
    return 'written';
  } catch (error) {
    return (error as { constraint_name?: string }).constraint_name ?? String(error);
  }
}
