// SPDX-License-Identifier: AGPL-3.0-only
//
// #1467: "Add page to context" on a task's page, in a conversation opened on
// no task, sends that task to the model exactly as a conversation opened on
// it would: its id and title reach the model, its body never does, and the
// answer cites it by its key. The page task is judged as a scope is (owner
// line 72): a client's task, one the person can no longer read and a key
// that names no task are refused and ask no model. A page that is not a task's
// sends no page. Through the server's own composition root, the replay
// stand-in on loopback and a fresh Postgres.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import { addClient, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, started, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { createApiFixture, type Answer } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const replyOf = (answer: Answer): Record<string, unknown> =>
  (answer.body as Record<string, Record<string, unknown>>)['reply'] ?? {};

let w: ConversationWorld;
let model: LocalModel;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  model = await localModel();
  const fixture = await createApiFixture('page_added');
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

async function task(title: string, description = ''): Promise<{ id: string; key: string }> {
  const made = await w.as(w.owner, 'task.create', { fields: { title, description } });
  expect(made.status).toBe(200);
  const id = String(made.body['recordId']);
  const [row] = await w.fixture.db.admin.execute<{ readonly key: string }>(
    `select txt_1 as key from public.records where id = $1`,
    [id],
  );
  return { id, key: String(row?.key) };
}

/** A conversation on no task, with `address` added as its page. */
async function withPage(address: string): Promise<string> {
  const conversationId = await started(w, w.owner, { body: `opened ${randomUUID()}` });
  const page = { address, shows: 'The task page' };
  const set = await w.as(w.owner, 'conversation.set_scope', { conversationId, page });
  expect(set.status).toBe(200);
  return conversationId;
}

const say = async (conversationId: string, body: string): Promise<Answer> =>
  await w.as(w.owner, 'conversation.message', { conversationId, body });

describe.skipIf(serverUrl === undefined)('a task page added to context', () => {
  it('sends the task’s id and title, never its body, and cites it by its key', async () => {
    const canary = `CANARY-${randomUUID()}`;
    const title = `Launch plan ${randomUUID()}`;
    const page = await task(title, `the body holds ${canary}`);
    const conversationId = await withPage(`/task/${page.key}`);
    const answer = await say(conversationId, 'What is this task about?');
    expect(lastFields()['page']).toBe(JSON.stringify({ task: page.id, title }));
    expect(model.provider.seen.at(-1)?.body).not.toContain(canary);
    expect(replyOf(answer)).toMatchObject({
      answered: true,
      cites: [{ label: title, href: `/task/${page.key}` }],
    });
    // A later question carries the page again.
    await say(conversationId, 'And what is due?');
    expect(lastFields()['page']).toBe(JSON.stringify({ task: page.id, title }));
  });

  it('a page that is not a task’s sends no page and cites nothing', async () => {
    const conversationId = await withPage('/board');
    const answer = await say(conversationId, 'Anything due?');
    expect(lastFields()['page']).toBeUndefined();
    expect(replyOf(answer)).toMatchObject({ answered: true, cites: [] });
  });
});

describe.skipIf(serverUrl === undefined)('a task page added to context, refused', () => {
  it('a client’s task asks no model', async () => {
    const { db, business } = w.fixture;
    await db.app.withBusiness(business, async (tx) => await grantTo(tx, w.owner, 'share'));
    const clientId = randomUUID();
    await addClient(db.app, business, clientId, w.owner);
    const page = await task('for a client');
    const [made] = await db.admin.execute<{ revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [page.id],
    );
    const linked = await w.as(w.owner, 'task.set_party', {
      operationId: randomUUID(),
      recordId: page.id,
      expectedRevision: Number(made?.revision),
      fields: { client: clientId },
    });
    expect(linked.status).toBe(200);
    const conversationId = await withPage(`/task/${page.key}`);
    const seen = model.provider.seen.length;
    const refused = await say(conversationId, `about the client ${randomUUID()}`);
    expect(replyOf(refused)).toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
    expect(model.provider.seen.length).toBe(seen);
  });

  it('a key that names no task asks no model', async () => {
    const conversationId = await withPage(`/task/T-${randomUUID().slice(0, 8)}`);
    const seen = model.provider.seen.length;
    const refused = await say(conversationId, 'hello?');
    // Every page refusal answers the person alike; the audit mark keeps the reason.
    expect(replyOf(refused)).toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
    expect(model.provider.seen.length).toBe(seen);
  });
});

describe.skipIf(serverUrl === undefined)('a task page added to context, read revoked', () => {
  it('a page whose read is revoked is not sent again', async () => {
    const { db, business } = w.fixture;
    const page = await task(`revoked ${randomUUID()}`);
    const conversationId = await withPage(`/task/${page.key}`);
    expect(replyOf(await say(conversationId, 'first'))).toMatchObject({ answered: true });
    const grants = await db.admin.execute<{ id: string }>(
      `select id from public.grants where business_id = $1 and subject_id = $2
         and collection = 'task' and action = 'read' and revoked_at is null`,
      [business, w.owner.personId],
    );
    await db.app.withBusiness(business, async (tx) => {
      for (const grant of grants) {
        // oxlint-disable-next-line no-await-in-loop -- one transaction
        await revokeGrant(tx, grant.id);
      }
    });
    const seen = model.provider.seen.length;
    const refused = await say(conversationId, 'second');
    expect(replyOf(refused)).toMatchObject({ answered: false });
    expect(model.provider.seen.length).toBe(seen);
  });
});
