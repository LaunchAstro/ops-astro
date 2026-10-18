// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function -- the review's proof, kept as written */
//
// #897: resends through `resend.ts` and the production client to the real
// API, its register and the conversation exchange over a loopback provider.
// A lost start, two lost later questions and a late lost replay each leave
// one durable question, reply, model call and provider send per question
// asked. Moved from the review's proof with its body unchanged.
import { afterEach, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { resends, type Asked } from '../../apps/web/src/assistant/resend.ts';
import { OperationsClient, isUnavailable } from '../../apps/web/src/operations/client.ts';
import { conversationWorld, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { createApiFixture, authorised, tokenFor } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: ConversationWorld | undefined;
let model: LocalModel | undefined;
afterEach(async () => {
  await model?.close();
  await w?.drop();
});

async function setup() {
  model = await localModel();
  const fixture = await createApiFixture('resend897');
  w = await conversationWorld({ fixture, api: composedWith(fixture, model.exchange) });
  const signedIn = authorised(await tokenFor(w.owner.presented.subject));
  const lose: string[] = [];
  const sent: { command: string; operationId: string }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const command = url.split('/').slice(-2).join('.');
    const body = JSON.parse(String(init?.body));
    sent.push({ command, operationId: body.operationId });
    const response = await w!.api.fetch(
      new Request(`http://api.test${url}`, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), ...signedIn },
      }),
    );
    const at = lose.indexOf(command);
    if (at >= 0) {
      lose.splice(at, 1);
      await response.text();
      throw new TypeError('The connection closed before the answer.');
    }
    return response;
  }) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const tab = resends();
  const send = async (command: Asked['command'], question: string, conversationId?: string) =>
    await tab.send(
      'tab',
      {
        command,
        question,
        request: { body: question, ...(conversationId ? { conversationId } : {}) },
      },
      (request, operationId) => client.mutate(command, request, { operationId }),
    );
  const totals = async () => {
    const rows = await w!.fixture.db.admin.execute<{
      conversations: number;
      questions: number;
      replies: number;
      calls: number;
    }>(`
      select (select count(*)::int from conversations) as conversations,
      (select count(*)::int from conversation_messages where role='person') as questions,
      (select count(*)::int from conversation_messages where role='agent') as replies,
      (select count(*)::int from model_calls) as calls`);
    return { ...rows[0], providerSends: model!.provider.seen.length };
  };
  return { lose, sent, send, totals, tab, client };
}

describe.skipIf(serverUrl === undefined)('a resent question', () => {
  it('a lost start replays its original operation with one durable reply and provider send', async () => {
    const api = await setup();
    api.lose.push('conversation.start');
    expect(isUnavailable(await api.send('conversation.start', 'A'))).toBe(true);
    expect(await api.totals()).toEqual({
      conversations: 1,
      questions: 1,
      replies: 1,
      calls: 1,
      providerSends: 1,
    });
    expect(await api.send('conversation.start', 'A')).toMatchObject({ ok: true });
    expect(api.sent[1]!.operationId).toBe(api.sent[0]!.operationId);
    expect(await api.totals()).toEqual({
      conversations: 1,
      questions: 1,
      replies: 1,
      calls: 1,
      providerSends: 1,
    });
  });

  it('a second lost question replays without another durable question or model call', async () => {
    const api = await setup();
    const start = await api.send('conversation.start', 'First');
    if (!('ok' in start)) throw new Error('start did not succeed');
    const id = String(start.value.detail?.['conversationId']);
    api.lose.push('conversation.message', 'conversation.message');
    expect(isUnavailable(await api.send('conversation.message', 'A', id))).toBe(true);
    expect(isUnavailable(await api.send('conversation.message', 'B', id))).toBe(true);
    expect(await api.send('conversation.message', 'B', id)).toMatchObject({ ok: true });
    expect(await api.send('conversation.message', 'A', id)).toMatchObject({ ok: true });
    expect(await api.totals()).toEqual({
      conversations: 1,
      questions: 3,
      replies: 3,
      calls: 3,
      providerSends: 3,
    });
    expect(api.sent[3]!.operationId).toBe(api.sent[2]!.operationId);
    expect(api.sent[4]!.operationId).toBe(api.sent[1]!.operationId);
  });

  it('a late lost replay cannot resurrect an identity whose retry already succeeded', async () => {
    const api = await setup();
    const first = await api.send('conversation.start', 'First');
    if (!('ok' in first)) throw new Error('start did not succeed');
    const conversationId = String(first.value.detail?.['conversationId']);
    api.lose.push('conversation.message');
    expect(isUnavailable(await api.send('conversation.message', 'A', conversationId))).toBe(true);
    const asked: Asked = {
      command: 'conversation.message',
      question: 'A',
      request: { conversationId, body: 'A' },
    };
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const late = api.tab.send('tab', asked, async (request, operationId) => {
      const result = await api.client.mutate('conversation.message', request, { operationId });
      expect(result).toMatchObject({ ok: true });
      arrived();
      await gate;
      return { unavailable: true, because: 'late replay response dropped' };
    });
    try {
      await reached;
      expect(await api.send('conversation.message', 'A', conversationId)).toMatchObject({
        ok: true,
      });
    } finally {
      release();
    }
    await late;
    expect(await api.send('conversation.message', 'A', conversationId)).toMatchObject({ ok: true });
    expect(await api.totals()).toEqual({
      conversations: 1,
      questions: 3,
      replies: 3,
      calls: 3,
      providerSends: 3,
    });
  });
});
