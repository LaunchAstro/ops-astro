// SPDX-License-Identifier: AGPL-3.0-only
//
// CS-7.30 over CS-7.40, through the server's own composition root and a fresh
// Postgres: what `conversation.models` offers a conversation follows its
// client's model-egress setting. The empty drawer and a conversation on no
// client are offered the install's models; one on a client whose egress is off
// is offered nothing; a providers list offers only the providers it names. A
// model chosen while offered and then made not offered (the client's egress
// switched off) refuses the next exchange before any provider call. No answer
// or refusal carries the client's name or the conversation's canary. A member
// whose read of the client's task is revoked learns nothing of the client's
// setting through an old conversation on it, and can choose no model there.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPLAY_MODEL_WINDOW } from '../../packages/core-connectors/src/index.ts';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import { addClient, enrol, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { blockedBefore, holdRow, waitPast } from '../support/lock-wait-race.ts';
import {
  CONVERSATION,
  conversationWorld,
  expiringSoon,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { createApiFixture, type Answer } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const ids = (answer: Answer): readonly unknown[] =>
  ((answer.body as { readonly models?: readonly { readonly id: unknown }[] }).models ?? []).map(
    (model) => model.id,
  );

// eslint-disable-next-line max-lines-per-function -- one client's egress, switched through each case
describe.skipIf(serverUrl === undefined)('the models a conversation is offered', () => {
  let w: ConversationWorld;
  let model: LocalModel;
  const clientId = randomUUID();
  const canary = `CANARY-${randomUUID()}`;
  let onClient = '';
  let clientTask = '';

  /** The client's egress as the database holds it; the command's own rules are C60's suites'. */
  const egress = async (providers: readonly string[]): Promise<void> => {
    await w.fixture.db.admin.execute(
      'update public.clients set model_egress = $2, model_providers = $3 where id = $1',
      [clientId, providers.length > 0, providers],
    );
  };
  const modelOf = async (id: string): Promise<unknown> =>
    (
      await w.fixture.db.admin.execute<{ readonly model_id: string | null }>(
        'select model_id from public.conversations where id = $1',
        [id],
      )
    )[0]?.model_id;
  const offered = async (conversationId?: string): Promise<Answer> =>
    await w.as(
      w.owner,
      'conversation.models',
      conversationId === undefined ? {} : { conversationId },
    );
  const carriesNothing = (answer: Answer): void => {
    const text = JSON.stringify(answer.body);
    for (const value of [canary, `client ${clientId}`, clientId]) expect(text).not.toContain(value);
  };

  beforeAll(async () => {
    model = await localModel();
    const fixture = await createApiFixture('conversation_models_egress');
    w = await conversationWorld({ fixture, api: composedWith(fixture, model.exchange) });
    const { db, business } = fixture;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, w.owner, 'share');
    });
    await addClient(db.app, business, clientId, w.owner);
    // The overseas-services register's assessed row for the stand-in provider (0052, APP 8.1).
    await db.admin.execute(
      `insert into public.overseas_services
         (business_id, id, service, receives, stored_where, trains_on_it, contract, to_confirm,
          in_use, updated_by_actor)
       values ($1, gen_random_uuid(), 'replay', 'test prompts', 'this machine', 'no', 'none',
               false, true, $2)`,
      [business, w.owner.actorId],
    );
    const made = await w.as(w.owner, 'task.create', { fields: { title: 'a client’s task' } });
    const placed = await w.as(w.owner, 'task.set_party', {
      operationId: randomUUID(),
      recordId: made.body['recordId'],
      expectedRevision: made.body['revision'],
      fields: { client: clientId },
    });
    expect(placed.status).toBe(200);
    clientTask = String(made.body['recordId']);
    onClient = await started(w, w.owner, {
      body: `${canary} how is this client going?`,
      scope: { kind: 'task', id: clientTask },
    });
  }, 180_000);

  afterAll(async () => {
    await model?.close();
    await w?.drop();
  });

  it('CS-7.30: the empty drawer and a conversation on no client are offered the install’s models', async () => {
    expect(ids(await offered())).toStrictEqual([REPLAY_MODEL_WINDOW.model]);
    const plain = await started(w, w.owner, { body: 'nothing about a client' });
    expect(ids(await offered(plain))).toStrictEqual([REPLAY_MODEL_WINDOW.model]);
  });

  it('CS-7.40: a client whose egress is off is offered nothing, and a choice is refused', async () => {
    const read = await offered(onClient);
    expect(read.status).toBe(200);
    expect(ids(read)).toStrictEqual([]);
    carriesNothing(read);
    const set = await w.as(w.owner, 'conversation.set_model', {
      conversationId: onClient,
      model: REPLAY_MODEL_WINDOW.model,
    });
    expect(set.status).toBe(422);
    expect(set.body).toMatchObject({ code: 'FIELD_VALUE_INVALID', names: ['model'] });
    carriesNothing(set);
  });

  it('CS-7.40: a providers list offers only the providers it names', async () => {
    await egress(['claude']);
    expect(ids(await offered(onClient))).toStrictEqual([]);
    await egress(['replay']);
    expect(ids(await offered(onClient))).toStrictEqual([REPLAY_MODEL_WINDOW.model]);
  });

  it('CS-7.30: a model chosen while offered, then not offered, refuses the next exchange before any call', async () => {
    await egress(['replay']);
    const set = await w.as(w.owner, 'conversation.set_model', {
      conversationId: onClient,
      model: REPLAY_MODEL_WINDOW.model,
    });
    expect(set.status).toBe(200);
    await egress([]);
    const seen = model.provider.seen.length;
    const next = await w.as(w.owner, 'conversation.message', {
      conversationId: onClient,
      body: 'and now?',
    });
    expect(next.status).toBe(200);
    expect((next.body as Record<string, unknown>)['reply']).toMatchObject({
      answered: false,
      code: 'MODEL_NOT_OFFERED',
    });
    carriesNothing(next);
    expect(model.provider.seen).toHaveLength(seen);
    expect(
      await w.count(
        'select count(*)::text as n from public.model_calls where conversation_id = $1',
        [onClient],
      ),
    ).toBe(0);
  });

  it('CS-7.40: after task read is revoked, an old conversation on the client offers nothing and takes no choice', async () => {
    const { db, business } = w.fixture;
    const member = await enrol(db.app, business, 'once-a-reader');
    const readGrant = await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, member, 'write', undefined, false, CONVERSATION);
      return await grantTo(tx, member, 'read', { kind: 'record', id: clientTask });
    });
    const old = await started(w, member, {
      body: 'while I can read it',
      scope: { kind: 'task', id: clientTask },
    });
    await db.app.withBusiness(business, async (tx) => {
      await revokeGrant(tx, readGrant);
    });
    const readOld = async (): Promise<Answer> =>
      await w.as(member, 'conversation.models', { conversationId: old });
    await egress(['replay']);
    const allowed = await readOld();
    expect(allowed.status).toBe(200);
    expect(ids(allowed)).toStrictEqual([]);
    const set = await w.as(member, 'conversation.set_model', {
      conversationId: old,
      model: REPLAY_MODEL_WINDOW.model,
    });
    expect(set.status).toBe(422);
    expect(set.body).toMatchObject({ code: 'FIELD_VALUE_INVALID', names: ['model'] });
    expect(await modelOf(old)).toBeNull();
    await egress([]);
    const off = await readOld();
    expect(off.status).toBe(200);
    expect(off.body).toStrictEqual(allowed.body);
    for (const answer of [allowed, set, off]) carriesNothing(answer);
  });

  it('CS-7.40: a task read that expires while a model choice waits for the conversation row takes no choice', async () => {
    const { db, business } = w.fixture;
    const member = await enrol(db.app, business, 'reader-till-the-wait');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, member, 'write', undefined, false, CONVERSATION);
      await grantTo(tx, member, 'read', { kind: 'record', id: clientTask });
    });
    const old = await started(w, member, {
      body: 'while I can read it',
      scope: { kind: 'task', id: clientTask },
    });
    await egress(['replay']);
    const { expiry } = await expiringSoon(w, member.personId, 'task', 'read');
    const held = await holdRow(db, 'select id from public.conversations where id = $1 for update', [
      old,
    ]);
    const sending = w.as(member, 'conversation.set_model', {
      conversationId: old,
      model: REPLAY_MODEL_WINDOW.model,
    });
    let startedLive = false;
    try {
      startedLive = await blockedBefore(db, held, expiry);
      await waitPast(db, expiry);
    } finally {
      await held.letGo();
    }
    const set = await sending;
    const kept = await modelOf(old);
    expect({
      startedLive,
      status: set.status,
      code: set.body['code'],
      model: kept,
    }).toEqual({ startedLive: true, status: 422, code: 'FIELD_VALUE_INVALID', model: null });
    carriesNothing(set);
  });

  /** A second client, A, whose egress allows replay, and a task placed on it. */
  const aTaskOnAnotherClient = async (): Promise<string> => {
    const { db, business } = w.fixture;
    const clientA = randomUUID();
    await addClient(db.app, business, clientA, w.owner);
    await db.admin.execute(
      `update public.clients set model_egress = true, model_providers = '{replay}' where id = $1`,
      [clientA],
    );
    const madeA = await w.as(w.owner, 'task.create', { fields: { title: 'client A’s task' } });
    const placedA = await w.as(w.owner, 'task.set_party', {
      operationId: randomUUID(),
      recordId: madeA.body['recordId'],
      expectedRevision: madeA.body['revision'],
      fields: { client: clientA },
    });
    expect(placedA.status).toBe(200);
    return String(madeA.body['recordId']);
  };

  it('CS-7.40 client to client: a member who keeps client A’s task read and loses client B’s is offered nothing on B and takes no choice there', async () => {
    const { db, business } = w.fixture;
    const taskA = await aTaskOnAnotherClient();
    const member = await enrol(db.app, business, 'reader-of-a-only');
    const readB = await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, member, 'write', undefined, false, CONVERSATION);
      await grantTo(tx, member, 'read', { kind: 'record', id: taskA });
      return await grantTo(tx, member, 'read', { kind: 'record', id: clientTask });
    });
    const onA = await started(w, member, { body: 'about A', scope: { kind: 'task', id: taskA } });
    const onB = await started(w, member, {
      body: 'about B',
      scope: { kind: 'task', id: clientTask },
    });
    await db.app.withBusiness(business, async (tx) => {
      await revokeGrant(tx, readB);
    });
    const read = async (id: string): Promise<Answer> =>
      await w.as(member, 'conversation.models', { conversationId: id });
    await egress(['replay']);
    expect(ids(await read(onA)), 'A is still read').toStrictEqual([REPLAY_MODEL_WINDOW.model]);
    const allowed = await read(onB);
    const set = await w.as(member, 'conversation.set_model', {
      conversationId: onB,
      model: REPLAY_MODEL_WINDOW.model,
    });
    await egress([]);
    const off = await read(onB);
    const kept = await modelOf(onB);
    expect({
      allowed: [allowed.status, ids(allowed)],
      set: [set.status, set.body['code'], set.body['names']],
      same: [off.status, off.body],
      model: kept,
    }).toStrictEqual({
      allowed: [200, []],
      set: [422, 'FIELD_VALUE_INVALID', ['model']],
      same: [200, allowed.body],
      model: null,
    });
    for (const answer of [allowed, set, off]) carriesNothing(answer);
  });
});
