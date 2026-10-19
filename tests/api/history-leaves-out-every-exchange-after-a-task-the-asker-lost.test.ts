// SPDX-License-Identifier: AGPL-3.0-only
//
// #1666 against Postgres (`chat-created-fixture.ts`): an earlier exchange
// whose card wrote, or whose snapshot held, a task the asker can no longer
// use (read revoked, a client's, trashed) is left out of what the model is
// sent, with every exchange after it, clicked, unclicked or plain, since a
// later reply may repeat it. The asked message still goes, with what came
// before. The read restored, the history comes back.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import { addClient, grantTo, type Member } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detail } from './aw-03-fixture.ts';
import { block, chatWorld, lastSeen, type ChatWorld } from './chat-created-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** A chat whose created task's content is repeated by an unclicked edit and a plain reply. */
async function repeated(c: ChatWorld, who: Member) {
  const canary = `CANARY-${randomUUID()}`;
  c.state.says = 'Hello.';
  const opened = await c.w.as(who, 'conversation.start', { body: 'before any task' });
  const conversationId = String(detail(opened)['conversationId']);
  c.state.says = block(
    JSON.stringify({ action: 'create', title: 'Secret plan', description: canary }),
  );
  const { reply } = await c.say(who, conversationId, 'Make a task for the plan');
  const task = await c.click(who, conversationId, reply);
  c.state.says = block(JSON.stringify({ action: 'edit', description: `${canary}, again` }));
  await c.say(who, conversationId, 'Say it again in the task');
  c.state.says = `It says ${canary}.`;
  await c.say(who, conversationId, 'What does it say?');
  c.state.says = 'Noted.';
  return { conversationId, task, canary };
}

/** The asked message goes, with only what came before the created task's exchange. */
async function askedWithout(c: ChatWorld, who: Member, conversationId: string, canary: string) {
  const seen = c.model.provider.seen.length;
  const { reply } = await c.say(who, conversationId, 'Anything else?');
  expect(reply).toMatchObject({ answered: true });
  expect(c.model.provider.seen.length).toBe(seen + 1);
  const { body, fields } = lastSeen(c.model);
  expect(body).not.toContain(canary);
  expect(fields['earlier']).toContain('before any task');
  expect(fields['message']).toBe('Anything else?');
}

// eslint-disable-next-line max-lines-per-function -- one world, each way a created task is lost
describe.skipIf(serverUrl === undefined)('history after a created task is lost', () => {
  let c: ChatWorld;

  beforeAll(async () => {
    c = await chatWorld('chat_created_history');
  }, 180_000);

  afterAll(async () => {
    await c?.close();
  });

  it('history: once the asker’s read of a created task is revoked, its exchange and every later one, clicked, unclicked or plain, reach no model; the read restored, they come back', async () => {
    const { who, read } = await c.member('history');
    const { conversationId, canary } = await repeated(c, who);
    const { db, business } = c.fixture;
    await db.app.withBusiness(business, async (tx) => await revokeGrant(tx, read));
    await askedWithout(c, who, conversationId, canary);
    await db.app.withBusiness(business, async (tx) => await grantTo(tx, who, 'read'));
    await c.say(who, conversationId, 'And now?');
    expect(lastSeen(c.model).fields['earlier']).toContain(canary);
  });

  it('history: a created task given a client takes its exchange and every later one out of what the model is sent', async () => {
    const { conversationId, task, canary } = await repeated(c, c.w.owner);
    const { db, business } = c.fixture;
    const clientId = randomUUID();
    await addClient(db.app, business, clientId, c.w.owner);
    const linked = await c.w.as(c.w.owner, 'task.set_party', {
      operationId: randomUUID(),
      recordId: task,
      expectedRevision: await c.revisionOf(task),
      fields: { client: clientId },
    });
    expect(linked.status).toBe(200);
    await askedWithout(c, c.w.owner, conversationId, canary);
  });

  it('history: a created task in the trash takes its exchange and every later one out of what the model is sent', async () => {
    const { conversationId, task, canary } = await repeated(c, c.w.owner);
    const trashed = await c.w.as(c.w.owner, 'task.trash', {
      operationId: randomUUID(),
      recordId: task,
      expectedRevision: await c.revisionOf(task),
    });
    expect(trashed.status).toBe(200);
    await askedWithout(c, c.w.owner, conversationId, canary);
  });
});
