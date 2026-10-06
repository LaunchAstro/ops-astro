// SPDX-License-Identifier: AGPL-3.0-only
//
// CS-7.30, through the server's own composition root, the replay provider on
// loopback behind the conversation seam, and a fresh Postgres: the owner
// chooses an offered model for their conversation, it is kept on the
// conversation, and the next exchange asks the provider for that exact model
// and records it on the call (0098). A model chosen before the first question
// rides in `conversation.start`, so the first exchange asks for it too. A
// model this install does not run is refused with nothing written, and one
// stored anyway is refused before any call. Crossings: another person in the
// business, a client of a shared task, and the same login in another business
// are each refused, and no answer or refusal carries the conversation's title,
// canary or id.
//
// The catalogue lists one model per provider, the replay adapter's default, so
// a choice that never reached the call would look the same. Here the replay
// provider is listed with a second model, and the second is the one chosen.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_ANSWER,
  LOCAL_GPT_DEFAULT_MODEL,
  REPLAY_MODEL_WINDOW,
} from '../../packages/core-connectors/src/index.ts';
import { grantTo, installSpine, shareWithClient, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  CONVERSATION,
  conversationWorld,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { authorised, createApiFixture, post, tokenFor, type Answer } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The second model the replay provider is listed with here: not its adapter's default. */
const CHOSEN = 'replay-2';

vi.mock('../../packages/core-connectors/src/index.ts', async (load) => {
  const actual = await load<typeof import('../../packages/core-connectors/src/index.ts')>();
  const listed = (provider: string) => {
    const models = actual.conversationModelsOf(provider);
    const first = models[0];
    return provider === 'replay' && first !== undefined
      ? [first, { ...first, id: 'replay-2' }]
      : models;
  };
  return { ...actual, conversationModelsOf: listed };
});

/** The same login as `member`, a member of `bravo` holding its own conversations there. */
async function sameLoginIn(w: ConversationWorld, member: Member): Promise<void> {
  const { db } = w.fixture;
  const bravo = await insertBusiness(db.app, 'bravo');
  await installSpine(db.app, bravo);
  await db.app.withBusiness(bravo, async (tx) => {
    const { insertActor, insertLogin, insertMapping, insertMembership, insertPerson } =
      await import('../identity/fixture.ts');
    const personId = await insertPerson(tx, 'owner-in-bravo');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, member.presented.subject), personId, actorId);
    await grantTo(
      tx,
      { personId, actorId, presented: member.presented },
      'write',
      undefined,
      false,
      CONVERSATION,
    );
  });
}

// eslint-disable-next-line max-lines-per-function -- one world, the choice then each crossing on it
describe.skipIf(serverUrl === undefined)('a conversation’s chosen model', () => {
  let w: ConversationWorld;
  let model: LocalModel;
  let conversationId = '';
  const canary = `CANARY-${randomUUID()}`;
  const title = `Title-${randomUUID()}`;

  const stored = async (): Promise<string | null> => {
    const [row] = await w.fixture.db.admin.execute<{ readonly model_id: string | null }>(
      'select model_id from public.conversations where id = $1',
      [conversationId],
    );
    return row?.model_id ?? null;
  };
  const callsOn = async (
    id: string,
  ): Promise<readonly { model_id: string | null; reserved_minor: string }[]> =>
    await w.fixture.db.admin.execute(
      `select model_id, reserved_minor::text from public.model_calls
        where conversation_id = $1 order by started_at`,
      [id],
    );
  const calls = async () => await callsOn(conversationId);
  const askedFor = (from: number): readonly unknown[] =>
    model.provider.seen
      .slice(from)
      .map((request) => (JSON.parse(request.body) as Record<string, unknown>)['model']);
  const carriesNothing = (answer: Answer): void => {
    const text = JSON.stringify(answer.body);
    for (const value of [canary, title, conversationId]) expect(text).not.toContain(value);
  };

  beforeAll(async () => {
    model = await localModel();
    const fixture = await createApiFixture('conversation_model_choice');
    w = await conversationWorld({ fixture, api: composedWith(fixture, model.exchange) });
    conversationId = await started(w, w.owner, { title, body: `${canary} what is due today?` });
  }, 180_000);

  afterAll(async () => {
    await model?.close();
    await w?.drop();
  });

  it('CS-7.30: the picker offers the install’s models with their price-book entry', async () => {
    const read = await w.as(w.owner, 'conversation.models', { conversationId });
    expect(read.status).toBe(200);
    const entry = {
      provider: 'replay',
      reach: 'local',
      ceilingMinor: CONVERSATION_ANSWER.maximumMinor,
    };
    expect(read.body).toStrictEqual({
      ok: true,
      models: [
        { id: REPLAY_MODEL_WINDOW.model, ...entry },
        { id: CHOSEN, ...entry },
      ],
      chosen: null,
    });
    // The first exchange, with no choice, asked for the default and recorded it.
    expect((await calls()).map((call) => call.model_id)).toStrictEqual([REPLAY_MODEL_WINDOW.model]);
  });

  it('CS-7.30: an offered model is kept, and the next exchange asks for it and records it', async () => {
    const set = await w.as(w.owner, 'conversation.set_model', { conversationId, model: CHOSEN });
    expect(set.status).toBe(200);
    expect(await stored()).toBe(CHOSEN);
    const before = model.provider.seen.length;
    const next = await w.as(w.owner, 'conversation.message', { conversationId, body: 'and now?' });
    expect((next.body as Record<string, unknown>)['reply']).toMatchObject({ answered: true });
    expect(askedFor(before)).toStrictEqual([CHOSEN]);
    // A plain conversation call holds nothing (0107: local, reserved 0); the price-book
    // entry is the ceiling a priced answer is held against.
    expect((await calls()).at(-1)).toEqual({ model_id: CHOSEN, reserved_minor: '0' });
  });

  it('CS-7.30: a model chosen before the first question is the one the first exchange asks for', async () => {
    const before = model.provider.seen.length;
    const opened = await w.as(w.owner, 'conversation.start', { body: 'first?', model: CHOSEN });
    expect(opened.status).toBe(200);
    expect((opened.body as Record<string, unknown>)['reply']).toMatchObject({ answered: true });
    const id = String((opened.body['detail'] as Record<string, unknown>)['conversationId']);
    expect(askedFor(before)).toStrictEqual([CHOSEN]);
    expect(await callsOn(id)).toEqual([{ model_id: CHOSEN, reserved_minor: '0' }]);
  });

  it('CS-7.30: a start naming a model not offered is refused by name, nothing kept or sent', async () => {
    const marker = `UNOFFERED-${randomUUID()}`;
    const before = model.provider.seen.length;
    const refused = await w.as(w.owner, 'conversation.start', {
      body: marker,
      model: LOCAL_GPT_DEFAULT_MODEL,
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'FIELD_VALUE_INVALID', names: ['model'] });
    expect(JSON.stringify(refused.body)).not.toContain(LOCAL_GPT_DEFAULT_MODEL);
    const kept = await w.fixture.db.admin.execute(
      'select id from public.conversation_messages where body = $1',
      [marker],
    );
    expect(kept).toEqual([]);
    expect(model.provider.seen).toHaveLength(before);
  });

  it('CS-7.30: a model this install does not run is refused by name, nothing written', async () => {
    const refused = await w.as(w.owner, 'conversation.set_model', {
      conversationId,
      model: LOCAL_GPT_DEFAULT_MODEL,
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'FIELD_VALUE_INVALID', names: ['model'] });
    expect(JSON.stringify(refused.body)).not.toContain(LOCAL_GPT_DEFAULT_MODEL);
    expect(await stored()).toBe(CHOSEN);
  });

  it('CS-7.30: a stored model this install does not run is refused before any call', async () => {
    await w.fixture.db.admin.execute(
      'update public.conversations set model_id = $2 where id = $1',
      [conversationId, LOCAL_GPT_DEFAULT_MODEL],
    );
    const before = { seen: model.provider.seen.length, calls: (await calls()).length };
    const next = await w.as(w.owner, 'conversation.message', { conversationId, body: 'again?' });
    expect((next.body as Record<string, unknown>)['reply']).toMatchObject({
      answered: false,
      code: 'MODEL_NOT_OFFERED',
    });
    expect(model.provider.seen).toHaveLength(before.seen);
    expect(await calls()).toHaveLength(before.calls);
    await w.fixture.db.admin.execute(
      'update public.conversations set model_id = $2 where id = $1',
      [conversationId, CHOSEN],
    );
  });

  it('CS-7.30 isolation: another person reads no offer and sets nothing on the owner’s conversation', async () => {
    const read = await w.as(w.colleague, 'conversation.models', { conversationId });
    expect(read.status).toBe(404);
    carriesNothing(read);
    const set = await w.as(w.colleague, 'conversation.set_model', { conversationId, model: null });
    expect(set.status).toBe(403);
    expect(set.body).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    carriesNothing(set);
    expect(await stored()).toBe(CHOSEN);
  });

  it('CS-7.30 isolation: a client of a shared task reads no offer and sets nothing', async () => {
    const { db, business } = w.fixture;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, w.owner, 'share');
    });
    const made = await w.as(w.owner, 'task.create', { fields: { title: 'shared with a client' } });
    const client = await shareWithClient(db.app, business, w.owner, String(made.body['recordId']));
    const read = await w.as(client, 'conversation.models', { conversationId });
    expect(read.status).toBe(404);
    carriesNothing(read);
    const set = await w.as(client, 'conversation.set_model', { conversationId, model: null });
    expect([403, 404]).toContain(set.status);
    carriesNothing(set);
    expect(await stored()).toBe(CHOSEN);
  });

  it('CS-7.30 isolation: the same login in another business reaches nothing, as a made-up id', async () => {
    await sameLoginIn(w, w.owner);
    const token = authorised(await tokenFor(w.owner.presented.subject));
    const crossed = await post(
      w.api,
      '/api/b/bravo/conversation/models',
      { conversationId },
      token,
    );
    const madeUp = await post(
      w.api,
      '/api/b/bravo/conversation/models',
      { conversationId: randomUUID() },
      token,
    );
    expect(crossed.status).toBe(404);
    expect(crossed.body).toStrictEqual(madeUp.body);
    carriesNothing(crossed);
    const set = await post(
      w.api,
      '/api/b/bravo/conversation/set_model',
      { operationId: randomUUID(), conversationId, model: null },
      token,
    );
    expect(set.status).toBe(404);
    carriesNothing(set);
    expect(await stored()).toBe(CHOSEN);
  });
});
