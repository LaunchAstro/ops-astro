// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #412: Sol's PRV-oa-745-R1 proof (title named by behaviour, body
// unchanged; R/sol/proofs/PRV-oa-745-R1-994aa7431.patch), and every other
// spelling the web router resolves to the same task (routes.ts, legacy.ts).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { addClient, enrol, grantTo } from '../commands/fixture.ts';
import { conversationWorld, started, type ConversationWorld } from './aw-03-fixture.ts';
import { serverUrl } from '../acceptance/world.ts';

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let w: ConversationWorld;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await conversationWorld('sol745page');
  await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
    await grantTo(tx, w.owner, 'share');
  });
}, 180_000);
afterAll(async () => await w?.drop());

async function taskOn(clientId: string, title: string): Promise<string> {
  await addClient(w.fixture.db.app, w.fixture.business, clientId, w.owner);
  const made = await w.as(w.owner, 'task.create', { fields: { title } });
  expect(made.status).toBe(200);
  const id = String(made.body['recordId']);
  const moved = await w.as(w.owner, 'task.set_party', {
    operationId: randomUUID(),
    recordId: id,
    expectedRevision: made.body['revision'],
    fields: { client: clientId },
  });
  expect(moved.status).toBe(200);
  const [stored] = await w.fixture.db.admin.execute<{ readonly client: string }>(
    'select uuid_7::text as client from public.records where id = $1',
    [id],
  );
  expect(stored?.client).toBe(clientId);
  return id;
}

it('client to client and person to person conversation pages hide unreadable tasks with a trailing slash', async () => {
  const visible = await taskOn(randomUUID(), 'client one work');
  const hiddenTitle = 'client two private page';
  const hidden = await taskOn(randomUUID(), hiddenTitle);
  const conversationId = await started(w, w.owner, {
    scope: { kind: 'task', id: visible },
    body: 'Discuss the visible work',
  });
  const reader = await enrol(w.fixture.db.app, w.fixture.business, 'sol745page-reader');
  await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
    await grantTo(tx, reader, 'read', { kind: 'record', id: visible }, false, 'conversation');
    await grantTo(tx, reader, 'read', { kind: 'record', id: visible });
  });
  expect((await w.as(reader, 'task.read', { recordId: hidden })).status).toBe(403);

  const setPage = async (address: string) => {
    const set = await w.as(w.owner, 'conversation.set_scope', {
      conversationId,
      page: { address, shows: hiddenTitle },
    });
    expect(set.status).toBe(200);
    const own = await w.as(w.owner, 'conversation.read', { conversationId });
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).toContain(hiddenTitle);
    const answer = await w.as(reader, 'conversation.read', { conversationId });
    expect(answer.status).toBe(200);
    return answer;
  };
  const canonical = await setPage(`/task/${hidden}`);
  expect(JSON.stringify(canonical.body)).not.toContain(hidden);
  const address = `/task/${hidden}/`;
  const answer = await setPage(address);
  expect(answer.body['conversation']).toMatchObject({ page: null });
  expect(JSON.stringify(answer.body)).not.toContain(hidden);
  expect(JSON.stringify(answer.body)).not.toContain(hiddenTitle);
});

it('a conversation page hides an unreadable task under every spelling that reaches it', async () => {
  const visible = await taskOn(randomUUID(), 'client one spelled work');
  const hiddenTitle = 'client two spelled page';
  const hidden = await taskOn(randomUUID(), hiddenTitle);
  const conversationId = await started(w, w.owner, {
    scope: { kind: 'task', id: visible },
    body: 'Discuss the spelled work',
  });
  const reader = await enrol(w.fixture.db.app, w.fixture.business, 'spelled-page-reader');
  await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
    await grantTo(tx, reader, 'read', { kind: 'record', id: visible }, false, 'conversation');
    await grantTo(tx, reader, 'read', { kind: 'record', id: visible });
  });
  const spellings = [
    `/task/${hidden}//`,
    `/task/${hidden}?tab=notes`,
    `/task/${hidden}#comments`,
    `/task/${hidden.toUpperCase()}`,
    `/task/${encodeURIComponent(hidden).replaceAll('-', '%2D')}`,
    `/TASK/${hidden}`,
    `/agency/task/?task=${hidden}`,
    `/agency/task?task=${hidden}`,
  ];
  for (const address of spellings) {
    // eslint-disable-next-line no-await-in-loop -- one page slot, set in turn
    const set = await w.as(w.owner, 'conversation.set_scope', {
      conversationId,
      page: { address, shows: hiddenTitle },
    });
    expect(set.status, address).toBe(200);
    // eslint-disable-next-line no-await-in-loop -- read after each set
    const answer = await w.as(reader, 'conversation.read', { conversationId });
    expect(answer.status, address).toBe(200);
    expect(answer.body['conversation'], address).toMatchObject({ page: null });
    expect(JSON.stringify(answer.body).toLowerCase(), address).not.toContain(hidden);
    expect(JSON.stringify(answer.body), address).not.toContain(hiddenTitle);
  }
  const readable = await w.as(w.owner, 'conversation.set_scope', {
    conversationId,
    page: { address: `/task/${visible}/`, shows: 'the visible page' },
  });
  expect(readable.status).toBe(200);
  const shown = await w.as(reader, 'conversation.read', { conversationId });
  expect(shown.body['conversation']).toMatchObject({ page: { shows: 'the visible page' } });
});
