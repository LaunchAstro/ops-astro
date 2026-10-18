// SPDX-License-Identifier: AGPL-3.0-only
//
// A question the server committed but whose answer was lost is resent the way
// the assistant resends it (`apps/web/src/assistant/resend.ts`): the same
// identity and request, through the production client, to the real API and
// its register and the conversation exchange over a loopback provider. The
// rows then hold one conversation and one durable question per question
// asked, and the resend starts no model call of its own. The control shows
// what a fresh identity does instead. Disposable databases only.

import { afterEach, describe, expect, it } from 'vitest';
import { resends, type Asked } from '../../apps/web/src/assistant/resend.ts';
import { OperationsClient, isUnavailable } from '../../apps/web/src/operations/client.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { authorised, createApiFixture, tokenFor } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let world: ConversationWorld | undefined;
let model: LocalModel | undefined;
afterEach(async () => {
  await model?.close();
  await world?.fixture.drop();
});

/** A conversation world whose questions the exchange answers through a loopback provider. */
async function answeringWorld(prefix: string): Promise<ConversationWorld> {
  model = await localModel();
  const fixture = await createApiFixture(prefix);
  return await conversationWorld({ fixture, api: composedWith(fixture, model.exchange) });
}

/** The production client over the real API, losing each named write's answer once it committed. */
async function clientOver(on: ConversationWorld, lose: string[]): Promise<OperationsClient> {
  const signedIn = authorised(await tokenFor(on.owner.presented.subject));
  const fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = { ...Object.fromEntries(new Headers(init?.headers)), ...signedIn };
    const response = await on.api.fetch(new Request(`http://api.test${url}`, { ...init, headers }));
    const command = url.split('/').slice(-2).join('.');
    const at = lose.indexOf(command);
    if (at === -1) return response;
    lose.splice(at, 1);
    await response.text();
    throw new TypeError('The connection closed before the answer.');
  }) as typeof globalThis.fetch;
  return new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
}

const count = async (on: ConversationWorld, sql: string): Promise<number> =>
  Number((await on.fixture.db.admin.execute<{ n: string }>(sql))[0]?.n ?? 0);

const totals = async (on: ConversationWorld) => ({
  conversations: await count(on, 'select count(*)::text as n from public.conversations'),
  questions: await count(
    on,
    "select count(*)::text as n from public.conversation_messages where role = 'person'",
  ),
  calls: await count(on, 'select count(*)::text as n from public.model_calls'),
  providerSends: model?.provider.seen.length ?? 0,
});

const start = (question: string): Asked => ({
  command: 'conversation.start',
  question,
  request: { body: question },
});

// oxlint-disable-next-line max-lines-per-function -- a start, a later question, then the control
describe.skipIf(serverUrl === undefined)('a question resent after its answer was lost', () => {
  it('a first question resent after its start answer was lost is one conversation and one question', async () => {
    world = await answeringWorld('resend_start');
    const client = await clientOver(world, ['conversation.start']);
    const tab = resends();
    const send = async () =>
      await tab.send('tab-1', start('What is due today?'), (request, operationId) =>
        client.mutate('conversation.start', request, { operationId }),
      );
    expect(isUnavailable(await send())).toBe(true);
    const lost = await totals(world);
    expect(lost).toStrictEqual({ conversations: 1, questions: 1, calls: 1, providerSends: 1 });
    expect(await send()).toMatchObject({ ok: true });
    expect(await totals(world)).toStrictEqual(lost);
  });

  it('a later question resent after its answer was lost is one durable question', async () => {
    world = await answeringWorld('resend_message');
    const client = await clientOver(world, ['conversation.message']);
    const tab = resends();
    const started = await tab.send('tab-1', start('First question'), (request, operationId) =>
      client.mutate('conversation.start', request, { operationId }),
    );
    if (!('ok' in started)) throw new Error(`the start was refused: ${JSON.stringify(started)}`);
    const conversationId = String(started.value.detail?.['conversationId']);
    const message: Asked = {
      command: 'conversation.message',
      question: 'Second question',
      request: { conversationId, body: 'Second question' },
    };
    const send = async () =>
      await tab.send('tab-1', message, (request, operationId) =>
        client.mutate('conversation.message', request, { operationId }),
      );
    expect(isUnavailable(await send())).toBe(true);
    const lost = await totals(world);
    expect(lost).toStrictEqual({ conversations: 1, questions: 2, calls: 2, providerSends: 2 });
    expect(await send()).toMatchObject({ ok: true });
    expect(await totals(world)).toStrictEqual(lost);
  });

  it('control: the same lost start sent again under a fresh identity is a second conversation', async () => {
    world = await answeringWorld('resend_control');
    const client = await clientOver(world, ['conversation.start']);
    const body = { body: 'What is due today?' };
    expect(isUnavailable(await client.mutate('conversation.start', body))).toBe(true);
    expect(await client.mutate('conversation.start', body)).toMatchObject({ ok: true });
    expect(await totals(world)).toStrictEqual({
      conversations: 2,
      questions: 2,
      calls: 2,
      providerSends: 2,
    });
  });
});
