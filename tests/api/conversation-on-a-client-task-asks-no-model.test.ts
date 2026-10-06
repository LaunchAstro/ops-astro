// SPDX-License-Identifier: AGPL-3.0-only
//
// Owner line 72, on the server: a client's material reaches no model while
// no true local model exists, and the laptop's GPT runner (LA-1) is a cloud
// model. A conversation opened on a task linked to a client keeps the
// person's message and asks nothing: no model call, nothing sent, no reply.
// Through the server's own composition root and a fresh Postgres, the client
// linked by `task.set_party` as the product links one.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import { addClient, enrol, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  CONVERSATION,
  conversationWorld,
  detail,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** A task the owner made and linked to a new client through `task.set_party`. */
async function clientTask(w: ConversationWorld): Promise<string> {
  const { db, business } = w.fixture;
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, w.owner, 'share');
  });
  const clientId = randomUUID();
  await addClient(db.app, business, clientId, w.owner);
  const made = await w.as(w.owner, 'task.create', { fields: { title: 'a task for a client' } });
  const taskId = String(made.body['recordId']);
  const placed = await w.as(w.owner, 'task.set_party', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: made.body['revision'],
    fields: { client: clientId },
  });
  expect(placed.status).toBe(200);
  return taskId;
}

describe.skipIf(serverUrl === undefined)('a conversation on a client’s task', () => {
  let w: ConversationWorld;
  let model: LocalModel;

  beforeAll(async () => {
    model = await localModel();
    const fixture = await createApiFixture('client_task_chat');
    w = await conversationWorld({ fixture, api: composedWith(fixture, model.exchange) });
  }, 180_000);

  afterAll(async () => {
    await model?.close();
    await w?.drop();
  });

  it('owner line 72: a conversation opened on a client’s task asks no model and keeps no reply', async () => {
    const { db } = w.fixture;
    const taskId = await clientTask(w);
    const canary = `CANARY-${randomUUID()}`;
    const opened = await w.as(w.owner, 'conversation.start', {
      body: `${canary} how is this client going?`,
      scope: { kind: 'task', id: taskId },
    });
    expect(opened.status).toBe(200);
    expect((opened.body as Record<string, unknown>)['reply']).toMatchObject({
      answered: false,
      code: 'CLIENT_MODEL_USE_OFF',
    });
    const conversationId = String(detail(opened)['conversationId']);
    const [rows] = await db.admin.execute<{ readonly calls: string; readonly agent: string }>(
      `select (select count(*) from public.model_calls where conversation_id = $1)::text as calls,
              (select count(*) from public.conversation_messages
                where conversation_id = $1 and role = 'agent')::text as agent`,
      [conversationId],
    );
    expect(rows).toEqual({ calls: '0', agent: '0' });
    expect(model.provider.seen).toEqual([]);
  });

  it('a conversation on a task its owner may no longer read asks no model', async () => {
    const { db, business } = w.fixture;
    const reader = await enrol(db.app, business, 'reader');
    const made = await w.as(w.owner, 'task.create', { fields: { title: 'a task with no client' } });
    const taskId = String(made.body['recordId']);
    const readGrant = await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, reader, 'write', undefined, false, CONVERSATION);
      return await grantTo(tx, reader, 'read', { kind: 'record', id: taskId });
    });
    const opened = await w.as(reader, 'conversation.start', {
      body: 'while I can read it',
      scope: { kind: 'task', id: taskId },
    });
    expect(opened.status).toBe(200);
    const conversationId = String(detail(opened)['conversationId']);
    await db.app.withBusiness(business, async (tx) => {
      await revokeGrant(tx, readGrant);
    });
    const seen = model.provider.seen.length;
    const canary = `CANARY-${randomUUID()}`;
    const sent = await w.as(reader, 'conversation.message', { conversationId, body: canary });
    expect(sent.status).toBe(200);
    expect((sent.body as Record<string, unknown>)['reply']).toMatchObject({
      answered: false,
      code: 'CLIENT_MODEL_USE_OFF',
    });
    expect(
      model.provider.seen
        .slice(seen)
        .map((request) => request.body)
        .join(''),
    ).not.toContain(canary);
    expect(model.provider.seen).toHaveLength(seen);
  });
});
