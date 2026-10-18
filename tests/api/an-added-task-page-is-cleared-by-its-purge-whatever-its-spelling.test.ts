// SPDX-License-Identifier: AGPL-3.0-only
//
// #1467: a task page added to context is resolved inside its own business and
// its conversation's owner alone, and a purge of the task clears the added
// page however its address spells the task (a percent-encoded key resolves
// to the task, so the purge clears it too) and advances the conversation's
// context epoch. Through the server's own composition root, the replay
// stand-in on loopback and a fresh Postgres.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageTaskOf } from '../../packages/core-commands/src/commands/conversation-page-task.ts';
import { writeBusinessSetting } from '../../packages/core-records/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
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

describe.skipIf(serverUrl === undefined)('an added task page, its boundaries', () => {
  it('an added page resolves inside its own business and only its owner may change or ask on it', async () => {
    const page = await task('PRIVATE-TENANT-CANARY');
    const other = await insertBusiness(w.fixture.db.app, `other-${randomUUID()}`);
    for (const ref of [page.id, page.key]) {
      // oxlint-disable-next-line no-await-in-loop -- each spelling in turn, in one business
      const resolved = await w.fixture.db.app.withBusiness(
        other,
        async (tx) => await pageTaskOf(tx, null, `/task/${ref}`),
      );
      expect(resolved).not.toBe(page.id);
      expect(resolved).not.toBeNull();
    }
    const conversationId = await withPage(`/task/${page.key}`);
    const seen = model.provider.seen.length;
    const changed = await w.as(w.colleague, 'conversation.set_scope', {
      conversationId,
      page: null,
    });
    expect(changed.status).toBe(403);
    const sent = await w.as(w.colleague, 'conversation.message', {
      conversationId,
      body: 'read their task',
    });
    expect(sent.status).toBe(403);
    expect(model.provider.seen.length).toBe(seen);
  });
});

describe.skipIf(serverUrl === undefined)('an added task page, purged', () => {
  it('a purge clears an added page spelt with an encoded key, and advances its epoch', async () => {
    const { db, business } = w.fixture;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, w.owner, 'manage');
      await writeBusinessSetting(tx, {
        key: 'retention_window_days',
        owningOperation: 'settings.set_retention_window',
        value: 0,
      });
    });
    const page = await task('encoded page to purge');
    // The resolver deliberately decodes this valid path to the same task.
    const address = `/task/%54${page.key.slice(1)}`;
    const conversationId = await withPage(address);
    expect(replyOf(await say(conversationId, 'on the encoded page'))).toMatchObject({
      answered: true,
    });
    expect(lastFields()['page']).toContain(page.id);
    const [before] = await db.admin.execute<{ epoch: number }>(
      'select context_epoch as epoch from public.conversations where id=$1',
      [conversationId],
    );
    const [row] = await db.admin.execute<{ revision: string }>(
      'select revision::text as revision from public.records where id=$1',
      [page.id],
    );
    expect(
      (
        await w.as(w.owner, 'task.trash', {
          operationId: randomUUID(),
          recordId: page.id,
          expectedRevision: Number(row?.revision),
        })
      ).status,
    ).toBe(200);
    await db.admin.execute(
      "update public.records set deleted_at=now()-interval '1 hour' where id=$1",
      [page.id],
    );
    const purged = await w.as(w.owner, 'task.purge', { operationId: randomUUID() });
    expect(purged.body['detail']).toMatchObject({ purgedIds: [page.id] });
    const [after] = await db.admin.execute<{ address: string | null; epoch: number }>(
      'select page_address as address, context_epoch as epoch from public.conversations where id=$1',
      [conversationId],
    );
    expect(after).toEqual({ address: null, epoch: Number(before?.epoch) + 1 });
  });
});
