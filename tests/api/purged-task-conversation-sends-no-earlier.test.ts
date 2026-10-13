// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation opened on a task, with a question answered before the task
// had a client, keeps its messages when the task is purged, and loses its
// scope. The next question in it must not carry that earlier answered
// question to the model in `earlier`: the purge marks the conversation's
// context as starting at the purge, and only messages from then on are sent.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeBusinessSetting } from '../../packages/core-records/src/index.ts';
import { addClient, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from '../api/aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from '../api/aw-03-exchange-fixture.ts';
import { createApiFixture } from '../api/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: ConversationWorld;
let model: LocalModel;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  model = await localModel();
  const fixture = await createApiFixture('purged_context');
  w = await conversationWorld({ fixture, api: composedWith(fixture, model.exchange) });
  await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    await grantTo(tx, w.owner, 'manage');
    await grantTo(tx, w.owner, 'share');
    const written = await writeBusinessSetting(tx, {
      key: 'retention_window_days',
      owningOperation: 'settings.set_retention_window',
      value: 0,
    });
    expect(written).not.toBeUndefined();
  });
}, 180_000);

afterAll(async () => {
  await model?.close();
  await w?.drop();
});

async function linkedConversation(body: string) {
  const made = await w.as(w.owner, 'task.create', { fields: { title: 'later a client task' } });
  expect(made.status).toBe(200);
  const taskId = String(made.body['recordId']);
  const opened = await w.as(w.owner, 'conversation.start', {
    body,
    scope: { kind: 'task', id: taskId },
  });
  expect(opened.body['reply']).toMatchObject({ answered: true });
  const clientId = randomUUID();
  await addClient(w.fixture.db.app, w.fixture.business, clientId, w.owner);
  const linked = await w.as(w.owner, 'task.set_party', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: made.body['revision'],
    fields: { client: clientId },
  });
  expect(linked.status).toBe(200);
  return {
    taskId,
    revision: linked.body['revision'],
    conversationId: String(detail(opened)['conversationId']),
  };
}

async function purge(taskId: string, revision: unknown) {
  const trashed = await w.as(w.owner, 'task.trash', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: revision,
  });
  expect(trashed.status).toBe(200);
  await w.fixture.db.admin.execute(
    "update public.records set deleted_at = now() - interval '1 hour' where business_id = $1 and id = $2",
    [w.fixture.business, taskId],
  );
  const purged = await w.as(w.owner, 'task.purge', { operationId: randomUUID() });
  expect(purged.status).toBe(200);
  expect(detail(purged)['purgedIds']).toContain(taskId);
}

describe.skipIf(serverUrl === undefined)(
  'a purged client task’s conversation and the earlier messages a model is sent',
  () => {
    it('a question answered before its task had a client is not sent again in earlier once the task is purged', async () => {
      const canary = `before-client-${randomUUID()}`;
      const { taskId, revision, conversationId } = await linkedConversation(canary);
      await purge(taskId, revision);
      const seen = model.provider.seen.length;
      const next = await w.as(w.owner, 'conversation.message', {
        conversationId,
        body: 'a new question after purge',
      });
      expect(next.status).toBe(200);
      expect(
        model.provider.seen
          .slice(seen)
          .map((request) => request.body)
          .join(''),
      ).not.toContain(canary);
    });
  },
);
