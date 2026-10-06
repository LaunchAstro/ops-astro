// SPDX-License-Identifier: AGPL-3.0-only
//
// What the exchange sends beside the person's message, and what the answer
// cites, through the server's own composition root, the replay stand-in on
// loopback and a fresh Postgres:
//
// - the page: the task's id and title reach the model, its body never does,
//   and the answer cites the task by its own key;
// - earlier: this conversation's earlier messages only, the last ten, under
//   the character bound and the GPT runner's request bytes, the oldest
//   dropped first;
// - a question refused on a client's task stays refused when it is sent
//   again with its operation id after the client is cleared;
// - a page task the caller can no longer read, or one in another business,
//   is never read, sent or cited.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contextOf,
  EARLIER_LIMIT,
} from '../../packages/core-commands/src/commands/conversation-context.ts';
import { LOCAL_GPT_BODY_LIMIT, localGptAdapter } from '../../packages/core-connectors/src/index.ts';
import { revokeGrant, withSession } from '../../packages/core-records/src/index.ts';
import { addClient, enrol, grantTo, installSpine } from '../commands/fixture.ts';
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
import { createApiFixture, type Answer } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const long = (mark: string): string => `${mark} ${'x'.repeat(3_000)}`;

const replyOf = (answer: Answer): Record<string, unknown> =>
  (answer.body as Record<string, Record<string, unknown>>)['reply'] ?? {};

// eslint-disable-next-line max-lines-per-function -- one world, each field the exchange sends
describe.skipIf(serverUrl === undefined)('an agent answer’s context and cites', () => {
  let w: ConversationWorld;
  let model: LocalModel;

  beforeAll(async () => {
    model = await localModel();
    const fixture = await createApiFixture('answer_context');
    w = await conversationWorld({ fixture, api: composedWith(fixture, model.exchange) });
  }, 180_000);

  afterAll(async () => {
    await model?.close();
    await w?.drop();
  });

  /** The fields of the last request the stand-in saw. */
  const lastFields = (): Record<string, string> =>
    (JSON.parse(model.provider.seen.at(-1)?.body ?? '{}') as { fields: Record<string, string> })
      .fields;

  async function task(title: string, description: string): Promise<{ id: string; key: string }> {
    const made = await w.as(w.owner, 'task.create', { fields: { title, description } });
    expect(made.status).toBe(200);
    const id = String(made.body['recordId']);
    const [row] = await w.fixture.db.admin.execute<{ readonly key: string }>(
      `select txt_1 as key from public.records where id = $1`,
      [id],
    );
    return { id, key: String(row?.key) };
  }

  async function say(conversationId: string, body: string): Promise<Answer> {
    const sent = await w.as(w.owner, 'conversation.message', { conversationId, body });
    expect(sent.status).toBe(200);
    return sent;
  }

  it('page canary: the task’s id and title reach the model, its body never does, and the answer cites the task by its key', async () => {
    const canary = `CANARY-${randomUUID()}`;
    const title = `Quarterly plan ${randomUUID()}`;
    const page = await task(title, `the body holds ${canary}`);
    const before = model.provider.seen.length;
    const opened = await w.as(w.owner, 'conversation.start', {
      body: 'What is this task about?',
      scope: { kind: 'task', id: page.id },
    });
    expect(opened.status).toBe(200);
    expect(model.provider.seen.length).toBe(before + 1);
    const sent = model.provider.seen.at(-1)?.body ?? '';
    expect(sent).not.toContain(canary);
    expect(lastFields()).toEqual({
      page: JSON.stringify({ task: page.id, title }),
      message: 'What is this task about?',
    });
    expect(replyOf(opened)).toMatchObject({
      answered: true,
      cites: [{ label: title, href: `/task/${page.key}` }],
    });
  });

  it('no page: an answer in a conversation on no task sends no page and cites nothing', async () => {
    const opened = await w.as(w.owner, 'conversation.start', { body: 'Anything due?' });
    expect(lastFields()).toEqual({ message: 'Anything due?' });
    expect(replyOf(opened)).toMatchObject({ answered: true, cites: [] });
  });

  it('earlier count: twelve earlier messages send only the last ten, oldest first, each by role, and none of another conversation', async () => {
    const other = await started(w, w.owner, { body: `other conversation ${randomUUID()}` });
    const conversationId = await started(w, w.owner, { body: 'question 1' });
    // In order, one after another: each message's place in the history is the point.
    // eslint-disable-next-line no-await-in-loop
    for (let n = 2; n <= 6; n += 1) await say(conversationId, `question ${String(n)}`);
    await say(other, 'never in the first conversation');
    await say(conversationId, 'question 7');
    const earlier = JSON.parse(lastFields()['earlier'] ?? '[]') as { role: string; body: string }[];
    expect(earlier).toHaveLength(10);
    expect(earlier[0]).toEqual({ role: 'person', body: 'question 2' });
    expect(earlier[1]).toEqual({ role: 'agent', body: 'Drafted.' });
    expect(earlier.at(-2)).toEqual({ role: 'person', body: 'question 6' });
    expect(earlier.at(-1)).toEqual({ role: 'agent', body: 'Drafted.' });
    expect(JSON.stringify(earlier)).not.toContain('question 1"');
    expect(JSON.stringify(earlier)).not.toContain('never in the first conversation');
    expect(lastFields()['message']).toBe('question 7');
  }, 60_000);

  it('a question refused on a client’s task never reaches the model, even once the task has no client', async () => {
    const { db, business } = w.fixture;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, w.owner, 'share');
    });
    const clientId = randomUUID();
    await addClient(db.app, business, clientId, w.owner);
    const made = await w.as(w.owner, 'task.create', { fields: { title: 'for a client soon' } });
    const taskId = String(made.body['recordId']);
    const opened = await w.as(w.owner, 'conversation.start', {
      body: 'before any client',
      scope: { kind: 'task', id: taskId },
    });
    expect(replyOf(opened)).toMatchObject({ answered: true });
    const conversationId = String(detail(opened)['conversationId']);
    const party = async (client: string | null, revision: unknown): Promise<Answer> =>
      await w.as(w.owner, 'task.set_party', {
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: revision,
        fields: { client },
      });
    const linked = await party(clientId, made.body['revision']);
    expect(linked.status).toBe(200);
    const canary = `CANARY-${randomUUID()}`;
    const refused = await say(conversationId, `${canary} about this client`);
    expect(replyOf(refused)).toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
    expect((await party(null, linked.body['revision'])).status).toBe(200);
    const seen = model.provider.seen.length;
    expect(replyOf(await say(conversationId, 'and now?'))).toMatchObject({ answered: true });
    expect(model.provider.seen.length).toBe(seen + 1);
    expect(lastFields()['earlier']).toContain('before any client');
    expect(model.provider.seen.map((request) => request.body).join('')).not.toContain(canary);
  }, 60_000);

  it('replay: a question refused on a client’s task, sent again with its operation id once the task has no client, reaches no model then or later', async () => {
    const { db, business } = w.fixture;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, w.owner, 'share');
    });
    const clientId = randomUUID();
    await addClient(db.app, business, clientId, w.owner);
    const made = await w.as(w.owner, 'task.create', { fields: { title: 'a client for a while' } });
    const taskId = String(made.body['recordId']);
    const opened = await w.as(w.owner, 'conversation.start', {
      body: 'before the client',
      scope: { kind: 'task', id: taskId },
    });
    const conversationId = String(detail(opened)['conversationId']);
    const party = async (client: string | null, revision: unknown): Promise<Answer> =>
      await w.as(w.owner, 'task.set_party', {
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: revision,
        fields: { client },
      });
    const linked = await party(clientId, made.body['revision']);
    expect(linked.status).toBe(200);
    const canary = `CANARY-${randomUUID()}`;
    const request = { operationId: randomUUID(), conversationId, body: `${canary} for the client` };
    const refused = await w.as(w.owner, 'conversation.message', request);
    expect(replyOf(refused)).toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
    expect((await party(null, linked.body['revision'])).status).toBe(200);
    const seen = model.provider.seen.length;
    const replayed = await w.as(w.owner, 'conversation.message', request);
    expect(replayed.status).toBe(200);
    expect(replyOf(replayed)).toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
    expect(model.provider.seen.length).toBe(seen);
    expect(replyOf(await say(conversationId, 'and next?'))).toMatchObject({ answered: true });
    expect(model.provider.seen.map((one) => one.body).join('')).not.toContain(canary);
  }, 60_000);

  it('earlier bytes: history is cut so the whole GPT request fits the runner, the message whole', async () => {
    const conversationId = await started(w, w.owner, { body: '界'.repeat(3_000) });
    const asked = '界'.repeat(20_000);
    await say(conversationId, asked);
    const fields = lastFields();
    expect(fields['message']).toBe(asked);
    expect(fields['earlier'] ?? '').not.toContain('界');
    expect(Buffer.byteLength(localGptAdapter(fields).body)).toBeLessThanOrEqual(
      LOCAL_GPT_BODY_LIMIT,
    );
  }, 60_000);

  it('earlier bound: a long history is sent under the character bound, the oldest dropped first', async () => {
    const conversationId = await started(w, w.owner, { body: long('first') });
    await say(conversationId, long('second'));
    await say(conversationId, long('third'));
    const asked = `asked ${'y'.repeat(9_000)}`;
    await say(conversationId, asked);
    const text = lastFields()['earlier'] ?? '';
    expect(text.length).toBeLessThanOrEqual(EARLIER_LIMIT);
    expect(text).not.toContain('first x');
    expect(text).toContain('third x');
    expect(lastFields()['message']).toBe(asked);
  }, 60_000);

  it('unseen page: a page task the asker can no longer read asks no model and cites nothing', async () => {
    const { db, business } = w.fixture;
    const title = `Not yours now ${randomUUID()}`;
    const page = await task(title, 'body');
    const reader = await enrol(db.app, business, `page-reader-${randomUUID().slice(0, 8)}`);
    const grant = await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, reader, 'write', undefined, false, CONVERSATION);
      return await grantTo(tx, reader, 'read', { kind: 'record', id: page.id });
    });
    const opened = await w.as(reader, 'conversation.start', {
      body: 'first',
      scope: { kind: 'task', id: page.id },
    });
    expect(replyOf(opened)).toMatchObject({ answered: true });
    await db.app.withBusiness(business, async (tx) => await revokeGrant(tx, grant));
    const before = model.provider.seen.length;
    const next = await w.as(reader, 'conversation.message', {
      conversationId: String(detail(opened)['conversationId']),
      body: 'and now?',
    });
    expect(replyOf(next)).toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
    expect(model.provider.seen.length).toBe(before);
  });

  it('two businesses: a task in another business is never read, sent or cited, and cannot be a page', async () => {
    const { db, business, member } = w.fixture;
    const bravo = await insertBusiness(db.app, `bravo-${randomUUID().slice(0, 8)}`);
    const spine = await installSpine(db.app, bravo);
    const foreignTitle = `Bravo secret ${randomUUID()}`;
    const foreign = randomUUID();
    await db.admin.execute(
      `insert into public.records (business_id, id, record_type_id, txt_1, txt_4)
       values ($1, $2, $3, 'T-1', $4)`,
      [bravo, foreign, spine.taskTypeId, foreignTitle],
    );
    const conversationId = await started(w, w.owner, { body: 'mine' });
    await expect(
      db.admin.execute(
        `update public.conversations set scope_kind = 'task', scope_record_id = $2 where id = $1`,
        [conversationId, foreign],
      ),
    ).rejects.toThrow(/foreign key/u);
    const [asked] = await db.admin.execute<{ readonly id: string }>(
      `select id from public.conversation_messages where conversation_id = $1`,
      [conversationId],
    );
    const context = await withSession(
      db.app,
      business,
      member.presented,
      async (tx, session) =>
        await contextOf(tx, session, { conversationId, messageId: String(asked?.id) }, foreign),
    );
    expect(context).toEqual({ refused: true, fields: [], cites: [] });
    expect(JSON.stringify(model.provider.seen)).not.toContain(foreignTitle);
  });
});
