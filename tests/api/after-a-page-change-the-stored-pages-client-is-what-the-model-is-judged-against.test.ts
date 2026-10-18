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

/** A task linked to a new client, by its id. */
async function aClientTask(): Promise<string> {
  const clientId = randomUUID();
  await w.fixture.db.app.withBusiness(
    w.fixture.business,
    async (tx) => await grantTo(tx, w.owner, 'share'),
  );
  await addClient(w.fixture.db.app, w.fixture.business, clientId, w.owner);
  const made = await w.as(w.owner, 'task.create', { fields: { title: 'A client page' } });
  expect(made.status).toBe(200);
  const linked = await w.as(w.owner, 'task.set_party', {
    operationId: randomUUID(),
    recordId: made.body['recordId'],
    expectedRevision: made.body['revision'],
    fields: { client: clientId },
  });
  expect(linked.status).toBe(200);
  return String(made.body['recordId']);
}

/** A conversation opened on an internal task, and a client's task page it can be given. */
async function openedOnInternal(): Promise<{ conversationId: string; address: string }> {
  const original = await w.as(w.owner, 'task.create', { fields: { title: 'Internal opening' } });
  expect(original.status).toBe(200);
  const conversationId = await started(w, w.owner, {
    body: `Opening on the internal task ${randomUUID()}`,
    scope: { kind: 'task', id: String(original.body['recordId']) },
  });
  return { conversationId, address: `/task/${await aClientTask()}` };
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

  it('a conversation opened on a client task stays refused after an internal page is added', async () => {
    const clientTask = await aClientTask();
    const onClient = await started(w, w.owner, {
      body: `Opening on the client task ${randomUUID()}`,
      scope: { kind: 'task', id: clientTask },
    });
    const inside = await w.as(w.owner, 'task.create', { fields: { title: 'An internal page' } });
    expect(inside.status).toBe(200);
    const changed = await w.as(w.owner, 'conversation.set_scope', {
      conversationId: onClient,
      page: { address: `/task/${String(inside.body['recordId'])}`, shows: 'An internal page' },
    });
    expect(changed.status).toBe(200);
    const before = model.provider.seen.length;
    const result = await w.as(w.owner, 'conversation.message', {
      conversationId: onClient,
      body: 'A question on the internal page',
    });
    expect(result.status).toBe(200);
    expect(result.body['reply']).toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
    expect(model.provider.seen.length, 'a page added since never lifts a client refusal').toBe(
      before,
    );
    const offered = await w.as(w.owner, 'conversation.models', { conversationId: onClient });
    expect(ids(offered)).toStrictEqual([]);
  });

  it('switching from client A to egress-disabled client B offers no model and refuses its selection', async () => {
    const a = await aClientTask();
    const b = await aClientTask();
    await w.fixture.db.admin.execute(
      `update public.clients set model_egress = true, model_providers = '{replay}' where id = (select uuid_7 from public.records where id = $1)`,
      [a],
    );
    await w.fixture.db.admin.execute(
      `insert into public.overseas_services
      (business_id, id, service, receives, stored_where, trains_on_it, contract, to_confirm, in_use, updated_by_actor)
      values ($1, gen_random_uuid(), 'replay', 'test prompts', 'this machine', 'no', 'none', false, true, $2)`,
      [w.fixture.business, w.owner.actorId],
    );
    const conversationId = await started(w, w.owner, {
      body: 'About A',
      scope: { kind: 'task', id: a },
    });
    const offeredA = ids(await w.as(w.owner, 'conversation.models', { conversationId }));
    expect(offeredA.length).toBeGreaterThan(0);
    const address = `/task/${b}`;
    expect(
      (
        await w.as(w.owner, 'conversation.set_scope', {
          conversationId,
          page: { address, shows: 'B' },
        })
      ).status,
    ).toBe(200);
    const [stored] = await w.fixture.db.admin.execute<{ address: string }>(
      'select page_address as address from public.conversations where id = $1',
      [conversationId],
    );
    expect(stored?.address).toBe(address);
    expect
      .soft(
        ids(await w.as(w.owner, 'conversation.models', { conversationId })),
        'B egress is disabled',
      )
      .toEqual([]);
    const selected = await w.as(w.owner, 'conversation.set_model', {
      conversationId,
      model: offeredA[0],
    });
    expect(selected.status, 'a model not offered on B must be refused').toBe(422);
  });

  it('a conversation opened on a client task with no page set is judged as that client, never as no client', async () => {
    const conversationId = await started(w, w.owner, {
      body: `Opening on the client task ${randomUUID()}`,
      scope: { kind: 'task', id: await aClientTask() },
    });
    const [stored] = await w.fixture.db.admin.execute<{ address: string | null }>(
      'select page_address as address from public.conversations where id = $1',
      [conversationId],
    );
    expect(stored?.address ?? null).toBeNull();
    expect(ids(await w.as(w.owner, 'conversation.models', { conversationId }))).toStrictEqual([]);
    const chosen = await w.as(w.owner, 'conversation.set_model', {
      conversationId,
      model: 'replay-1',
    });
    expect(chosen.status, 'a model the client never allowed is refused').toBe(422);
    const before = model.provider.seen.length;
    const asked = await w.as(w.owner, 'conversation.message', {
      conversationId,
      body: 'A question about the client',
    });
    expect(asked.body['reply']).toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
    expect(model.provider.seen.length).toBe(before);
  });

  it('a client-opened conversation given an internal page offers no model, refuses a selection and never calls the provider', async () => {
    const onClient = await started(w, w.owner, {
      body: `Opening on the client task ${randomUUID()}`,
      scope: { kind: 'task', id: await aClientTask() },
    });
    const inside = await w.as(w.owner, 'task.create', { fields: { title: 'An internal page' } });
    expect(inside.status).toBe(200);
    const changed = await w.as(w.owner, 'conversation.set_scope', {
      conversationId: onClient,
      page: { address: `/task/${String(inside.body['recordId'])}`, shows: 'An internal page' },
    });
    expect(changed.status).toBe(200);
    const offered = await w.as(w.owner, 'conversation.models', { conversationId: onClient });
    expect(offered.status).toBe(200);
    expect(ids(offered), 'an internal page never lifts a client conversation').toStrictEqual([]);
    const chosen = await w.as(w.owner, 'conversation.set_model', {
      conversationId: onClient,
      model: 'replay-1',
    });
    expect(chosen.status, 'a model on an internal page of a client conversation is refused').toBe(
      422,
    );
    const before = model.provider.seen.length;
    const asked = await w.as(w.owner, 'conversation.message', {
      conversationId: onClient,
      body: 'A question on the internal page',
    });
    expect(asked.body['reply']).toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
    expect(model.provider.seen.length, 'the provider is never called').toBe(before);
  });
});
