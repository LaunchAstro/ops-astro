// SPDX-License-Identifier: AGPL-3.0-only
//
// Owner line 72 on the conversation path: the owner's GPT session is a cloud
// subscription, judged by the same rule as a task's run. The broker finds the
// conversation's source from its rows: the owner's own conversation, on no
// task or on a task the owner started with no client, with every person turn
// the owner's. A conversation on a client's task is refused by name and the
// runner sees nothing; a conversation the owner does not hold, or one another
// person typed in, waits on a local model.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import {
  catalogue,
  LOCAL_GPT_COMPOSE,
  LOCAL_GPT_CONVERSATION,
  LOCAL_GPT_PROVIDER,
  localGptAdapter,
  localGptCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import {
  callModelForPlanning,
  callModelInConversation,
  type Broker,
  type ClaimedField,
  type ConversationScope,
} from '../../packages/core-custody/src/index.ts';
import { insertActor, insertPerson } from '../identity/fixture.ts';
import { createTask } from '../runtime/schedules-harness.ts';
import { seedConversation } from './conversation-fixture.ts';
import { broker, noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { LOCAL_REPLY, startStubRunner, type StubRunner } from './local-gpt-stub.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('line72talk');

let runner: StubRunner;

beforeAll(async () => {
  if (noDatabase) return;
  runner = await startStubRunner();
}, 60_000);

afterAll(async () => {
  await runner?.close();
});

/** The laptop's GPT session: a cloud route carried by the owner's subscription. */
const gpt = (): Broker => ({
  ...broker,
  custody: runner.custody,
  operations: catalogue([LOCAL_GPT_CONVERSATION, LOCAL_GPT_COMPOSE]),
  providers: new Map([[LOCAL_GPT_PROVIDER, { build: localGptAdapter, price: localGptCostMinor }]]),
  routes: [
    {
      key: 'local_gpt',
      reach: 'cloud',
      provider: LOCAL_GPT_PROVIDER,
      credentialRef: 'local_runner',
      credentialKind: 'subscription',
      installation: 'here',
      ceiling: 4,
    },
  ],
  localOwnerTesting: true,
});

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

/** The conversation opened on `taskId`, as the drawer stores its scope. */
async function onTask(conversation: ConversationScope, taskId: string): Promise<void> {
  await s.db.admin.execute(
    `update public.conversations set scope_kind = 'task', scope_record_id = $2 where id = $1`,
    [conversation.id, taskId],
  );
}

async function forClient(taskId: string): Promise<void> {
  await s.db.admin.execute(
    `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
    [taskId, randomUUID()],
  );
}

/** A turn in the conversation, by `actorId`; its id. */
async function turn(
  conversation: ConversationScope,
  role: 'person' | 'agent',
  body: string,
  actorId: string = s.decider.actorId,
): Promise<string> {
  const id = randomUUID();
  await s.db.admin.execute(
    `insert into public.conversation_messages
       (business_id, id, conversation_id, role, author_actor_id, body, created_at)
     values ($1, $2, $3, $4, $5, $6, clock_timestamp())`,
    [s.business, id, conversation.id, role, actorId, body],
  );
  return id;
}

/** A person turn in the conversation written by someone other than its owner. */
async function anotherTurn(conversation: ConversationScope): Promise<void> {
  const actorId = await s.db.app.withBusiness(
    s.business,
    async (tx) => await insertActor(tx, await insertPerson(tx, 'Someone else')),
  );
  await turn(conversation, 'person', 'from someone else', actorId);
}

interface Asked {
  readonly conversation: ConversationScope;
  readonly fields: readonly ClaimedField[];
  readonly messageId?: string;
}

/** The owner's conversation with one earlier exchange and the asked message, all stored. */
async function asked(taskId?: string): Promise<Asked> {
  const conversation = await seedConversation(s);
  if (taskId !== undefined) await onTask(conversation, taskId);
  await turn(conversation, 'person', 'hello');
  await turn(conversation, 'agent', 'hi');
  const body = `fix the typo ${randomUUID()}`;
  const messageId = await turn(conversation, 'person', body);
  const fields: ClaimedField[] = [
    {
      name: 'earlier',
      source: 'outside',
      value: JSON.stringify([
        { role: 'person', body: 'hello' },
        { role: 'agent', body: 'hi' },
      ]),
    },
    { name: 'message', source: 'outside', value: body },
  ];
  if (taskId !== undefined) {
    const page = JSON.stringify({ task: taskId, title: 'About' });
    fields.unshift({ name: 'page', source: 'outside', value: page });
  }
  return { conversation, fields, messageId };
}

async function ask(question: Asked) {
  return await callModelInConversation(
    s.db.app,
    s.business,
    { actorId: s.decider.actorId, delegationId: null, attendedByPersonId: s.decider.personId },
    { ...question, operation: LOCAL_GPT_CONVERSATION.key },
    gpt(),
  );
}

const callsOn = async (conversation: ConversationScope) =>
  await s.db.admin.execute<{ route_reach: string; credential_kind: string }>(
    'select route_reach, credential_kind from public.model_calls where conversation_id = $1',
    [conversation.id],
  );

it("the owner's own conversation on the owner's task with no client is answered on the subscription, recorded as cloud", async () => {
  await holdsRole('owner');
  runner.mode('answer');
  const question = await asked(await createTask(s, 'About page'));
  const before = runner.seen.length;
  expect(await ask(question)).toMatchObject({ ok: true, text: LOCAL_REPLY });
  expect(runner.seen.length).toBe(before + 1);
  expect(await callsOn(question.conversation)).toEqual([
    { route_reach: 'cloud', credential_kind: 'subscription' },
  ]);
}, 60_000);

it("a conversation on a client's task never reaches the subscription", async () => {
  await holdsRole('owner');
  runner.mode('answer');
  const taskId = await createTask(s, 'Client page');
  await forClient(taskId);
  const question = await asked(taskId);
  const before = runner.seen.length;
  expect(await ask(question)).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK',
    callId: null,
  });
  expect(runner.seen.length).toBe(before);
  expect(await callsOn(question.conversation)).toEqual([]);
}, 60_000);

const replaced = (question: Asked, name: string, value: string): Asked => ({
  ...question,
  fields: question.fields.map((field) => (field.name === name ? { ...field, value } : field)),
});

it.each([
  ['its person is staff, not the owner', async (q: Asked) => (await holdsRole('member'), q)],
  ['another person typed in it', async (q: Asked) => (await anotherTurn(q.conversation), q)],
  [
    'the page names another task',
    async (q: Asked) =>
      replaced(q, 'page', JSON.stringify({ task: await createTask(s, 'Other'), title: 'Other' })),
  ],
  [
    'an earlier turn is not one of its own',
    (q: Asked) =>
      replaced(q, 'earlier', JSON.stringify([{ role: 'person', body: 'a client wrote this' }])),
  ],
  ['the message is not the stored one', (q: Asked) => replaced(q, 'message', 'other words')],
  [
    'the message names no id',
    (q: Asked): Asked => ({ conversation: q.conversation, fields: q.fields }),
  ],
  [
    'a field it does not know is supplied',
    (q: Asked): Asked => ({
      ...q,
      fields: [...q.fields, { name: 'extra', source: 'outside' as const, value: 'x' }],
    }),
  ],
])(
  'a conversation where %s waits on a local model',
  async (_how, arrange) => {
    await holdsRole('owner');
    runner.mode('answer');
    const question = await arrange(await asked(await createTask(s, 'About page')));
    const before = runner.seen.length;
    expect(await ask(question)).toEqual({
      ok: false,
      code: 'LOCAL_MODEL_REQUIRED',
      callId: null,
    });
    expect(runner.seen.length).toBe(before);
  },
  60_000,
);

it("a planning reply on a client's task never reaches the subscription", async () => {
  await holdsRole('owner');
  runner.mode('answer');
  const taskId = await createTask(s, 'Client plan');
  await forClient(taskId);
  const question = await asked(taskId);
  const before = runner.seen.length;
  const answer = await callModelForPlanning(
    s.db.app,
    s.business,
    { actorId: s.decider.actorId, delegationId: null, attendedByPersonId: s.decider.personId },
    { ...question, operation: LOCAL_GPT_COMPOSE.key },
    gpt(),
  );
  expect(answer).toEqual({ ok: false, code: 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK', callId: null });
  expect(runner.seen.length).toBe(before);
  expect(await callsOn(question.conversation)).toEqual([]);
}, 60_000);
