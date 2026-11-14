// SPDX-License-Identifier: AGPL-3.0-only
//
// The edges of `pageTaskOf` (#2407, S1930-2) that Sol's rounds on #2410
// found without a runtime case. A stored page that names no live task of this
// business (an undecodable reference, a task in the bin, an id no task here
// holds, or a real task of another business) is judged as a task that is
// gone: nothing is offered and no model is asked. A page that is not a task's
// leaves the task the conversation was opened on, so an internal opening is
// still offered models and a client's opening is still refused. A
// conversation opened on a task gone since, given an internal page, is judged
// as gone too: never as no client's. Through the server's own composition
// root, the replay stand-in on loopback and a fresh Postgres.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageTaskOf } from '../../packages/core-commands/src/commands/conversation-page-task.ts';
import { addClient, grantTo } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
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
  const fixture = await createApiFixture('page_task_edges');
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

/** A new task of this business, internal unless a client is linked, by its id and revision. */
async function aTask(client = false): Promise<{ id: string; revision: unknown }> {
  const made = await w.as(w.owner, 'task.create', { fields: { title: 'An edge task' } });
  expect(made.status).toBe(200);
  const id = String(made.body['recordId']);
  if (!client) return { id, revision: made.body['revision'] };
  const clientId = randomUUID();
  await w.fixture.db.app.withBusiness(
    w.fixture.business,
    async (tx) => await grantTo(tx, w.owner, 'share'),
  );
  await addClient(w.fixture.db.app, w.fixture.business, clientId, w.owner);
  const linked = await w.as(w.owner, 'task.set_party', {
    operationId: randomUUID(),
    recordId: id,
    expectedRevision: made.body['revision'],
    fields: { client: clientId },
  });
  expect(linked.status).toBe(200);
  return { id, revision: linked.body['revision'] };
}

async function trash(task: { id: string; revision: unknown }): Promise<void> {
  const trashed = await w.as(w.owner, 'task.trash', {
    operationId: randomUUID(),
    recordId: task.id,
    expectedRevision: task.revision,
  });
  expect(trashed.status).toBe(200);
}

async function openedOn(taskId: string): Promise<string> {
  return await started(w, w.owner, {
    body: `Opening ${randomUUID()}`,
    scope: { kind: 'task', id: taskId },
  });
}

async function givePage(conversationId: string, address: string): Promise<void> {
  const changed = await w.as(w.owner, 'conversation.set_scope', {
    conversationId,
    page: { address, shows: 'A page' },
  });
  expect(changed.status).toBe(200);
}

/** What the conversation is offered, and whether its next question reached the provider. */
async function judged(conversationId: string): Promise<{ offered: number; asked: boolean }> {
  const offered = ids(await w.as(w.owner, 'conversation.models', { conversationId })).length;
  const before = model.provider.seen.length;
  const result = await w.as(w.owner, 'conversation.message', {
    conversationId,
    body: `A question ${randomUUID()}`,
  });
  expect(result.status).toBe(200);
  return { offered, asked: model.provider.seen.length > before };
}

const GONE = { offered: 0, asked: false };
/** The id `pageTaskOf` answers for a page naming no live task of this business. */
const NO_TASK = '00000000-0000-4000-8000-000000000000';

describe.skipIf(serverUrl === undefined)('a stored page with no live task here', () => {
  it('an internal opening given an undecodable task page is judged as gone', async () => {
    const conversationId = await openedOn((await aTask()).id);
    await givePage(conversationId, '/task/%E0%A4%A');
    expect(await judged(conversationId)).toStrictEqual(GONE);
  });

  it('an internal opening given the page of a task in the bin is judged as gone', async () => {
    const conversationId = await openedOn((await aTask()).id);
    const binned = await aTask();
    await trash(binned);
    await givePage(conversationId, `/task/${binned.id}`);
    expect(await judged(conversationId)).toStrictEqual(GONE);
  });

  it('an internal opening given a page naming an id no task of this business holds is judged as gone', async () => {
    const conversationId = await openedOn((await aTask()).id);
    await givePage(conversationId, `/task/${randomUUID()}`);
    expect(await judged(conversationId)).toStrictEqual(GONE);
  });

  it('a page that is not a task page keeps an internal opening: offered and asked', async () => {
    const conversationId = await openedOn((await aTask()).id);
    await givePage(conversationId, '/inbox');
    const after = await judged(conversationId);
    expect(after.offered).toBeGreaterThan(0);
    expect(after.asked, 'the internal opening task is still answered').toBe(true);
  });

  it("a page that is not a task page keeps a client's opening: refused and offered nothing", async () => {
    const conversationId = await openedOn((await aTask(true)).id);
    await givePage(conversationId, '/inbox');
    expect(await judged(conversationId)).toStrictEqual(GONE);
  });

  it('an opening task gone since, given an internal page, is judged as gone, never as no client', async () => {
    const opening = await aTask();
    const conversationId = await openedOn(opening.id);
    await trash(opening);
    await givePage(conversationId, `/task/${(await aTask()).id}`);
    expect(await judged(conversationId)).toStrictEqual(GONE);
  });
});

describe.skipIf(serverUrl === undefined)("a page naming another business's task", () => {
  it('a page naming a real task of another business is judged as gone there, by id or key, whatever the opening', async () => {
    const foreign = await aTask();
    const [row] = await w.fixture.db.admin.execute<{ readonly key: string }>(
      'select txt_1 as key from public.records where id = $1',
      [foreign.id],
    );
    const other = await insertBusiness(w.fixture.db.app, `other-${randomUUID()}`);
    const judgedThere: unknown[] = [];
    for (const opening of [null, randomUUID()]) {
      for (const ref of [foreign.id, String(row?.key)]) {
        // oxlint-disable-next-line no-await-in-loop -- each opening and spelling in turn, in the other business
        const task = await w.fixture.db.app.withBusiness(
          other,
          async (tx) => await pageTaskOf(tx, opening, `/task/${ref}`),
        );
        judgedThere.push(task);
      }
    }
    expect(judgedThere, 'never the foreign task, always gone').toStrictEqual([
      NO_TASK,
      NO_TASK,
      NO_TASK,
      NO_TASK,
    ]);
  });
});
