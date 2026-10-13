// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1's laptop carve-out, through the real broker, custody and a stand-in
// runner: a conversation's page pointer and earlier messages are declared
// fields of the conversation operation, so the owner's GPT session still
// answers when they go with the message, and the runner sees exactly them.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import {
  catalogue,
  LOCAL_GPT_CONVERSATION,
  LOCAL_GPT_PROVIDER,
  localGptAdapter,
  localGptCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import { callModelInConversation } from '../../packages/core-custody/src/index.ts';
import { seedConversation } from './conversation-fixture.ts';
import { broker, noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { LOCAL_REPLY, startStubRunner, type StubRunner } from './local-gpt-stub.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('la1context');

let runner: StubRunner;

beforeAll(async () => {
  if (noDatabase) return;
  runner = await startStubRunner();
}, 60_000);

afterAll(async () => {
  await runner?.close();
});

it('LA-1 side panel: the page and the earlier messages go with the message under the carve-out, and it answers', async () => {
  runner.mode('answer');
  const before = runner.seen.length;
  const message = `and this? ${randomUUID()}`;
  const page = JSON.stringify({ task: randomUUID(), title: 'Quarterly plan' });
  const earlier = JSON.stringify([{ role: 'person', body: 'hello' }]);
  const result = await callModelInConversation(
    s.db.app,
    s.business,
    { actorId: s.decider.actorId, delegationId: null, attendedByPersonId: s.decider.personId },
    {
      conversation: await seedConversation(s),
      operation: LOCAL_GPT_CONVERSATION.key,
      fields: [
        { name: 'page', source: 'outside', value: page },
        { name: 'earlier', source: 'outside', value: earlier },
        { name: 'message', source: 'outside', value: message },
      ],
    },
    {
      ...broker,
      custody: runner.custody,
      operations: catalogue([LOCAL_GPT_CONVERSATION]),
      providers: new Map([
        [LOCAL_GPT_PROVIDER, { build: localGptAdapter, price: localGptCostMinor }],
      ]),
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
    },
  );
  expect(result).toMatchObject({ ok: true, text: LOCAL_REPLY });
  expect(runner.seen.length).toBe(before + 1);
  expect(JSON.parse(runner.seen.at(-1)?.body ?? '{}')).toEqual({
    model: 'gpt-6.1-sol',
    fields: { page, earlier, message },
  });
}, 60_000);
