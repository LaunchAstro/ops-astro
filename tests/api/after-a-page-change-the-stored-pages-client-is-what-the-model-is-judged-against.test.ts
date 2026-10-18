// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof for S1930-1 on #1930 (01a326f), moved by behaviour (register
// 78). A conversation opened on an internal task, then given a client's task
// as its page by `conversation.set_scope`, is judged against the stored page's
// client: the next question asks no model, and the models offered are the
// client's, not the opening task's. Through the server's own composition
// root, the replay stand-in on loopback and a fresh Postgres.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addClient, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, started, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { createApiFixture, type Answer } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: ConversationWorld;
let model: LocalModel;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  model = await localModel();
  const fixture = await createApiFixture('stored_page_client');
  w = await conversationWorld({ fixture, api: composedWith(fixture, model.exchange) });
}, 180_000);
afterAll(async () => {
  await model?.close();
  await w?.drop();
});

const ids = (answer: Answer): readonly unknown[] =>
  ((answer.body as { readonly models?: readonly { readonly id: unknown }[] }).models ?? []).map(
    (one) => one.id,
  );

/** A conversation opened on an internal task, and a client's task page it can be given. */
async function openedOnInternal(): Promise<{ conversationId: string; address: string }> {
  const original = await w.as(w.owner, 'task.create', { fields: { title: 'Internal opening' } });
  expect(original.status).toBe(200);
  const conversationId = await started(w, w.owner, {
    body: `Opening on the internal task ${randomUUID()}`,
    scope: { kind: 'task', id: String(original.body['recordId']) },
  });
  const clientId = randomUUID();
  await w.fixture.db.app.withBusiness(
    w.fixture.business,
    async (tx) => await grantTo(tx, w.owner, 'share'),
  );
  await addClient(w.fixture.db.app, w.fixture.business, clientId, w.owner);
  const next = await w.as(w.owner, 'task.create', { fields: { title: 'A client page' } });
  expect(next.status).toBe(200);
  const linked = await w.as(w.owner, 'task.set_party', {
    operationId: randomUUID(),
    recordId: next.body['recordId'],
    expectedRevision: next.body['revision'],
    fields: { client: clientId },
  });
  expect(linked.status).toBe(200);
  return { conversationId, address: `/task/${String(next.body['recordId'])}` };
}

// eslint-disable-next-line max-lines-per-function -- Sol's proof for S1930-1 kept as written, and its models case
describe.skipIf(serverUrl === undefined)('after a page change, the stored page is judged', () => {
  it('after a page change the stored page client prevents a model call despite an internal opening scope', async () => {
    const original = await w.as(w.owner, 'task.create', {
      fields: { title: 'Internal opening task' },
    });
    expect(original.status).toBe(200);
    const conversationId = await started(w, w.owner, {
      body: 'Opening on the internal task',
      scope: { kind: 'task', id: String(original.body['recordId']) },
    });
    const clientId = randomUUID();
    await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) => await grantTo(tx, w.owner, 'share'),
    );
    await addClient(w.fixture.db.app, w.fixture.business, clientId, w.owner);
    const next = await w.as(w.owner, 'task.create', { fields: { title: 'Client page task' } });
    expect(next.status).toBe(200);
    const linked = await w.as(w.owner, 'task.set_party', {
      operationId: randomUUID(),
      recordId: next.body['recordId'],
      expectedRevision: next.body['revision'],
      fields: { client: clientId },
    });
    expect(linked.status).toBe(200);
    const address = `/task/${String(next.body['recordId'])}`;
    const changed = await w.as(w.owner, 'conversation.set_scope', {
      conversationId,
      page: { address, shows: 'Client page' },
    });
    expect(changed.status).toBe(200);
    const [stored] = await w.fixture.db.admin.execute<{ address: string }>(
      'select page_address as address from public.conversations where id = $1',
      [conversationId],
    );
    expect(stored?.address).toBe(address);
    const before = model.provider.seen.length;
    const result = await w.as(w.owner, 'conversation.message', {
      conversationId,
      body: 'Question about the client page',
    });
    expect(result.status).toBe(200);
    expect
      .soft(result.body['reply'])
      .toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
    expect(model.provider.seen.length, 'the stored page client must block model dispatch').toBe(
      before,
    );
  });

  it('after a page change the models offered follow the stored page client, not the opening task', async () => {
    const { conversationId, address } = await openedOnInternal();
    const internal = await w.as(w.owner, 'conversation.models', { conversationId });
    expect(internal.status).toBe(200);
    expect(ids(internal).length).toBeGreaterThan(0);
    const changed = await w.as(w.owner, 'conversation.set_scope', {
      conversationId,
      page: { address, shows: 'A client page' },
    });
    expect(changed.status).toBe(200);
    const onClient = await w.as(w.owner, 'conversation.models', { conversationId });
    expect(onClient.status).toBe(200);
    expect(ids(onClient), 'a client whose egress is off is offered nothing').toStrictEqual([]);
  });
});
