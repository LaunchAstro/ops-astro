// SPDX-License-Identifier: AGPL-3.0-only
//
// Owner line 72 on the conversation path, by who wrote each turn and by every
// byte sent: a turn its author wrote while holding no owner role stays theirs
// after they become the owner, and a page pointer or an earlier-turns value
// carrying anything beyond what its rows hold never reaches the subscription.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import {
  catalogue,
  LOCAL_GPT_CONVERSATION,
  LOCAL_GPT_PROVIDER,
  localGptAdapter,
  localGptCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import {
  callModelInConversation,
  type Broker,
  type ClaimedField,
} from '../../packages/core-custody/src/index.ts';
import { broker, noDatabase, s, useBrokerWorld } from './broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;
import { holding, ownersPageQuestion, seedConversation } from './conversation-fixture.ts';
import { startStubRunner, type StubRunner } from './local-gpt-stub.ts';

useBrokerWorld('line72bytes');
let runner: StubRunner;
beforeAll(async () => {
  if (noDatabase) return;
  runner = await startStubRunner();
}, 60_000);
afterAll(async () => {
  await runner?.close();
});

const gpt = (): Broker => ({
  ...broker,
  custody: runner.custody,
  operations: catalogue([LOCAL_GPT_CONVERSATION]),
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

it('conversation text a client contact entered stays off the subscription after its author becomes the owner', async () => {
  await holding(s, 'member');
  await s.db.admin.execute(
    `update public.memberships set role_key = 'client_contact'
      where business_id = $1 and person_id = $2 and active`,
    [s.business, s.decider.personId],
  );
  const conversation = await seedConversation(s);
  const messageId = randomUUID();
  const body = 'Synthetic client-entered confidential brief';
  await s.db.admin.execute(
    `insert into public.conversation_messages
      (business_id, id, conversation_id, role, author_actor_id, body, created_at)
      values ($1, $2, $3, 'person', $4, $5, clock_timestamp())`,
    [s.business, messageId, conversation.id, s.decider.actorId, body],
  );
  // Retain the membership history, as the product and the PR's task proofs do.
  await holding(s, 'owner');
  const seen = runner.seen.length;
  const answer = await callModelInConversation(
    s.db.app,
    s.business,
    { actorId: s.decider.actorId, delegationId: null, attendedByPersonId: s.decider.personId },
    {
      conversation,
      messageId,
      operation: LOCAL_GPT_CONVERSATION.key,
      fields: [{ name: 'message', source: 'outside', value: body }],
    },
    gpt(),
  );
  const outgoing = runner.seen.slice(seen).map((row) => JSON.parse(row.body).fields.message);
  expect(outgoing, 'Client-entered text must never reach the subscription').toEqual([]);
  expect(answer).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
}, 60_000);

it.each(['page', 'earlier'] as const)(
  'text in the %s value that no row holds never reaches the subscription',
  async (name) => {
    const body = 'Owner question';
    const question = await ownersPageQuestion(s, 'Owner task', 'Owner earlier turn', body);
    const syntheticClientText = 'Synthetic client text absent from every source row';
    const value =
      name === 'page'
        ? JSON.stringify({
            task: question.taskId,
            title: 'Owner task',
            clientText: syntheticClientText,
          })
        : JSON.stringify([
            { role: 'person', body: 'Owner earlier turn', clientText: syntheticClientText },
          ]);
    const fields: ClaimedField[] = [
      { name, source: 'outside', value },
      { name: 'message', source: 'outside', value: body },
    ];
    const seen = runner.seen.length;
    const answer = await callModelInConversation(
      s.db.app,
      s.business,
      { actorId: s.decider.actorId, delegationId: null, attendedByPersonId: s.decider.personId },
      { ...question, fields, operation: LOCAL_GPT_CONVERSATION.key },
      gpt(),
    );
    const sent = runner.seen.slice(seen).map((row) => JSON.parse(row.body).fields[name]);
    expect(sent, 'Every byte sent must be bound to the source rows').toEqual([]);
    expect(answer).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
  },
  60_000,
);
it('a page value naming its own task twice over, the first carrying other text, never reaches the subscription', async () => {
  const body = 'Owner question, duplicated key';
  const question = await ownersPageQuestion(s, 'Owner task', 'Owner earlier turn', body);
  // JSON.parse keeps the last `title`; the bytes sent keep both.
  const value = `{"task":"${question.taskId}","title":"Synthetic client text","title":"Owner task"}`;
  const seen = runner.seen.length;
  const answer = await callModelInConversation(
    s.db.app,
    s.business,
    { actorId: s.decider.actorId, delegationId: null, attendedByPersonId: s.decider.personId },
    {
      ...question,
      fields: [
        { name: 'page', source: 'outside', value },
        { name: 'message', source: 'outside', value: body },
      ],
      operation: LOCAL_GPT_CONVERSATION.key,
    },
    gpt(),
  );
  expect(runner.seen.length).toBe(seen);
  expect(answer).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
}, 60_000);
