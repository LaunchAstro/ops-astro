// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-03's exchange, through the server's own composition root and a fresh
// Postgres: a person's question in their own conversation goes to AW-01's
// broker on the conversation seam, and the answer is kept as the agent's
// reply to that one message. The model is custody's real process and the
// replay provider on loopback; the stored rows, read as admin, are the oracle.
//
// The crossings each check the status, that no reply came back, that no model
// call was made and nothing was sent, and that no body carries the owner's
// words or conversation: another business, another client in the same
// business, another person in it, and the owner's own agent under a live
// delegation. Each is also asked of the exchange itself, not only of the
// command in front of it.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConversationReply } from '../../packages/core-commands/src/index.ts';
import type { ModelAnswer } from '../../packages/core-connectors/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { openReplayBroker, type ReplayBroker } from '../broker/replay-broker.ts';
import { enrol, grantTo, installSpine, shareWithClient, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  CONVERSATION,
  conversationWorld,
  detail,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { agentPath, personPath, type Controls } from './controls-fixture.ts';
import { authorised, post, tokenFor, type Answer } from './fixture.ts';
import { checksWorld, pickedUpOn, type PickedUp } from './mp-6-1-checks-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const replyOf = (answer: Answer): unknown => (answer.body as Record<string, unknown>)['reply'];
const messageOf = (answer: Answer): string => String(detail(answer)['messageId']);

// eslint-disable-next-line max-lines-per-function -- one world, the exchange and each crossing on it
describe.skipIf(serverUrl === undefined)('AW-03 the exchange', () => {
  let c: Controls;
  let w: ConversationWorld;
  let model: LocalModel;
  let work: PickedUp;
  const canary = `CANARY-${randomUUID()}`;

  const count = async (sql: string, parameters: readonly unknown[]): Promise<number> =>
    await w.count(sql, parameters);
  const agentRows = async (conversationId: string): Promise<number> =>
    await count(
      `select count(*) as n from public.conversation_messages
        where conversation_id = $1 and role = 'agent'`,
      [conversationId],
    );
  const calls = async (): Promise<number> =>
    await count(
      `select count(*) as n from public.model_calls where conversation_id is not null`,
      [],
    );

  beforeAll(async () => {
    ({ c } = await checksWorld('aw_03_exchange'));
    model = await localModel();
    w = await conversationWorld({
      fixture: c.fixture,
      api: composedWith(c.fixture, model.exchange),
    });
    work = await pickedUpOn(c, 'exchange_crossing');
  }, 180_000);

  afterAll(async () => {
    await model?.close();
    await c?.drop();
  });

  it('AW-03 exchange applied: the owner’s question goes to the local model and its answer is kept as the agent’s reply to it', async () => {
    const opened = await w.as(w.owner, 'conversation.start', { body: 'What is on this week?' });
    expect(opened.status).toBe(200);
    expect(replyOf(opened)).toEqual({
      answered: true,
      messageId: expect.any(String) as string,
      body: 'Drafted.',
    } satisfies ConversationReply);
    const conversationId = String(detail(opened)['conversationId']);
    expect(model.provider.seen.at(-1)?.body).toContain('What is on this week?');
    const rows = await c.fixture.db.admin.execute(
      `select role, body, answers_message_id::text as answers, author_actor_id::text as author
         from public.conversation_messages where conversation_id = $1 order by created_at, role desc`,
      [conversationId],
    );
    expect(rows).toEqual([
      { role: 'person', body: 'What is on this week?', answers: null, author: w.owner.actorId },
      { role: 'agent', body: 'Drafted.', answers: messageOf(opened), author: w.owner.actorId },
    ]);
    const next = await w.as(w.owner, 'conversation.message', {
      conversationId,
      body: 'And next week?',
    });
    expect(replyOf(next)).toMatchObject({ answered: true, body: 'Drafted.' });
    expect(await agentRows(conversationId)).toBe(2);
  });

  it('AW-03 exchange applied: a repeat of the same operation answers with the same reply and calls the model once', async () => {
    const conversationId = await started(w, w.owner, { body: 'first' });
    const token = authorised(await tokenFor(w.owner.presented.subject));
    const operationId = randomUUID();
    const send = async (): Promise<Answer> =>
      await post(
        w.api,
        personPath('conversation.message'),
        { operationId, conversationId, body: 'twice?' },
        token,
      );
    const before = await calls();
    const once = await send();
    const again = await send();
    expect(replyOf(once)).toMatchObject({ answered: true });
    expect(again.body).toEqual(once.body);
    expect(await calls()).toBe(before + 1);
    expect(await agentRows(conversationId)).toBe(2);
  });

  it('AW-03 egress off: with only a cloud model, through the server’s own broker, the agent says models are off and sends nothing', async () => {
    const cloud: ReplayBroker = await openReplayBroker();
    try {
      const api: Hono = composedWith(c.fixture, cloud.exchange);
      const before = await calls();
      const answer = await post(
        api,
        personPath('conversation.start'),
        { operationId: randomUUID(), body: `${canary} how is the client going?` },
        authorised(await tokenFor(w.owner.presented.subject)),
      );
      expect(answer.status).toBe(200);
      expect(replyOf(answer)).toEqual({
        answered: false,
        code: 'LOCAL_MODEL_REQUIRED',
        words: expect.stringMatching(/models are off/iu) as string,
      } satisfies ConversationReply);
      expect(JSON.stringify(replyOf(answer))).not.toContain(canary);
      const conversationId = String(detail(answer)['conversationId']);
      expect(await agentRows(conversationId)).toBe(0);
      expect(await calls()).toBe(before);
      expect(cloud.provider.seen).toEqual([]);
      const kept = await count(
        `select count(*) as n from public.conversation_messages
          where conversation_id = $1 and role = 'person'`,
        [conversationId],
      );
      expect(kept).toBe(1);
    } finally {
      await cloud.close();
    }
  });

  // eslint-disable-next-line max-lines-per-function -- every crossing against one owned message
  it('AW-03 exchange isolation: another business, another client, another person and the owner’s agent get no answer, and nothing is sent', async () => {
    const opened = await w.as(w.owner, 'conversation.start', { body: `${canary} private` });
    const conversationId = String(detail(opened)['conversationId']);
    const messageId = messageOf(opened);
    const { db, business } = c.fixture;
    const taskId = (await c.createTask('client one')).id;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, w.owner, 'share');
    });
    const client = await shareWithClient(db.app, business, w.owner, taskId);
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, client, 'write', { kind: 'record', id: taskId }, false, CONVERSATION);
    });
    const bravo = await insertBusiness(db.app, 'bravo');
    await installSpine(db.app, bravo);
    const both: Member = await enrol(db.app, bravo, 'both');
    await db.app.withBusiness(bravo, async (tx) => {
      await grantTo(tx, both, 'write', undefined, false, CONVERSATION);
    });
    const sent = model.provider.seen.length;
    const before = await calls();
    const replies = await agentRows(conversationId);
    const foreign = [canary, conversationId, messageId, 'Drafted.'];
    const carriesNothing = (answer: Answer): void => {
      expect(answer.status).toBeGreaterThanOrEqual(400);
      expect(replyOf(answer)).toBeUndefined();
      const text = JSON.stringify(answer.body);
      for (const value of foreign) expect(text).not.toContain(value);
    };
    const message = { conversationId, body: 'mine now' };

    // Another business: the same conversation id from Bravo is a made-up id.
    const bravoToken = authorised(await tokenFor(both.presented.subject));
    const across = await post(
      w.api,
      '/api/b/bravo/conversation/message',
      { operationId: randomUUID(), ...message },
      bravoToken,
    );
    const madeUp = await post(
      w.api,
      '/api/b/bravo/conversation/message',
      { operationId: randomUUID(), ...message, conversationId: randomUUID() },
      bravoToken,
    );
    expect(across.status).toBe(404);
    expect(across.body).toEqual(madeUp.body);
    carriesNothing(across);
    // Another client in the same business, holding write on its shared task.
    carriesNothing(await w.as(client, 'conversation.message', message));
    // Another person in the business.
    const colleague = await w.as(w.colleague, 'conversation.message', message);
    expect(colleague.status).toBe(403);
    carriesNothing(colleague);
    // The owner's own agent, under a live delegation.
    const agent = await post(
      w.api,
      agentPath('conversation.message'),
      { operationId: randomUUID(), ...message },
      {
        ...authorised(await tokenFor(c.fixture.agent.subject)),
        'x-agent-delegation': work.credential,
      },
    );
    carriesNothing(agent);

    // The exchange itself, asked directly for the owner's message by each of them.
    const asked = { conversationId, messageId };
    const direct = async (businessId: BusinessId, presented: Member['presented']) =>
      await model.exchange(db.app, businessId, presented, asked);
    expect(await direct(bravo, both.presented)).toBeUndefined();
    expect(await direct(business, client.presented)).toBeUndefined();
    expect(await direct(business, w.colleague.presented)).toBeUndefined();
    expect(await direct(business, c.fixture.agent)).toBeUndefined();

    expect(model.provider.seen.length).toBe(sent);
    expect(await calls()).toBe(before);
    expect(await agentRows(conversationId)).toBe(replies);
  });

  it('AW-03 canary: planted message content and a planted provider answer never reach a log, an error, the audit payload, the register or the model call record', async () => {
    const said: string[] = [];
    const heard = (...parts: unknown[]): void => {
      said.push(parts.map(String).join(' '));
    };
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(heard),
      vi.spyOn(console, 'warn').mockImplementation(heard),
      vi.spyOn(console, 'error').mockImplementation(heard),
    ];
    model.provider.mode('planted');
    let planted = '';
    try {
      const answer = await w.as(w.owner, 'conversation.start', { body: `${canary} planted?` });
      const reply = replyOf(answer) as { readonly answered: boolean; readonly body?: string };
      expect(reply.answered).toBe(true);
      planted = String(reply.body);
      expect(planted.length).toBeGreaterThan(0);
    } finally {
      model.provider.mode('answer');
      for (const spy of spies) spy.mockRestore();
    }
    const rows = await c.fixture.db.admin.execute<{ readonly row: string }>(
      `select row_to_json(a)::text as row from public.audit_events a
       union all select row_to_json(r)::text from public.operations r
       union all select row_to_json(m)::text from public.model_calls m`,
      [],
    );
    for (const text of [...rows.map((row) => row.row), ...said]) {
      expect(text).not.toContain(canary);
      expect(text).not.toContain(planted);
    }
  });

  it('MP-7-11 hostile provider: an oversized, redirected, malformed or slow answer is a failed reply, and nothing is kept', async () => {
    const conversationId = await started(w, w.owner, { body: 'hostile?' });
    for (const mode of ['oversized', 'redirect', 'malformed', 'slow'] as const) {
      model.provider.mode(mode);
      try {
        // eslint-disable-next-line no-await-in-loop -- one mode at a time on one provider
        const answer = await w.as(w.owner, 'conversation.message', {
          conversationId,
          body: `and in ${mode}?`,
        });
        expect(answer.status).toBe(200);
        expect(replyOf(answer)).toEqual({
          answered: false,
          code: expect.any(String) as string,
          words: expect.stringMatching(/could not be used/iu) as string,
        });
        expect(JSON.stringify(answer.body)).not.toContain('203.0.113.9');
      } finally {
        model.provider.mode('answer');
      }
    }
    expect(await agentRows(conversationId)).toBe(1);
  }, 60_000);

  it('MP-7-11 hostile provider: an answer longer than a message may be is a failed reply, and nothing is kept', async () => {
    const long = await localModel((body: unknown): ModelAnswer | undefined =>
      typeof body === 'object' && body !== null
        ? {
            text: 'x'.repeat(20_001),
            model: 'replay-1',
            usage: { inputUnits: 1, outputUnits: 1 },
            providerCode: null,
          }
        : undefined,
    );
    try {
      const api = composedWith(c.fixture, long.exchange);
      const answer = await post(
        api,
        personPath('conversation.start'),
        { operationId: randomUUID(), body: 'a long answer?' },
        authorised(await tokenFor(w.owner.presented.subject)),
      );
      expect(replyOf(answer)).toMatchObject({ answered: false });
      expect(await agentRows(String(detail(answer)['conversationId']))).toBe(0);
    } finally {
      await long.close();
    }
  });
});
