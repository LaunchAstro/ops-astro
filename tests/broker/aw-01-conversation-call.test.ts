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
  type Broker,
  type ConversationCallRequest,
  type ModelCaller,
  type ModelCallResult,
} from '../../packages/core-custody/src/index.ts';
import { REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
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

const inConversation = async (
  caller: ModelCaller,
  request: ConversationCallRequest,
  with_: Broker = withRoutes([LOCAL]),
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

it('AW-01 conversation egress off: a cloud route from a conversation is refused before any row or request', async () => {
  const request = ask();
  const before = await callCount();
  const sent = world.provider.seen.length;
  const result = await inConversation(person(), request, withRoutes([CLOUD]));
  expect(result).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED', callId: null });
  expect(JSON.stringify(result)).not.toContain(PLANTED_PROMPT);
  expect(await callCount()).toBe(before);
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
