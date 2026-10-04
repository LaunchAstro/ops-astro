// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #412, OW-031 criterion 2: Sol's proof, unchanged
// (R/sol/proofs/OW-031-4126931d1.patch), with the setup and helpers it uses;
// the file's other criteria are not this issue's.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeWrapUp } from '../../packages/core-commands/src/index.ts';
import {
  conversationWorld,
  setConversationWindow,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import { createControls, type Controls } from './controls-fixture.ts';
import { addClient, enrol, grantTo } from '../commands/fixture.ts';

let w: ConversationWorld;
let c: Controls;
const wrap = async (conversationId: string) =>
  await w.fixture.db.app.withBusiness(
    w.fixture.business,
    async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: '4126931' }),
  );
const task = async (title: string, conversationId?: string) => {
  const answer = await w.as(w.owner, 'task.create', {
    fields: { title },
    ...(conversationId === undefined ? {} : { conversationId }),
  });
  expect(answer.status).toBe(200);
  return String(answer.body['recordId']);
};
const setClient = async (taskId: string, clientId: string) => {
  const read = await w.as(w.owner, 'task.read', { recordId: taskId });
  expect(read.status).toBe(200);
  const answer = await w.as(w.owner, 'task.set_party', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: (read.body['task'] as { revision: number }).revision,
    fields: { client: clientId },
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
};

/** catalogue #412: the conversation's scope id reaches only a reader who may read that task. */
async function scopeBlindReader(): Promise<void> {
  const scoped = await task('scope the reader may not read');
  const other = await task('a task the reader may read');
  const conversationId = await started(w, w.owner, {
    scope: { kind: 'task', id: scoped },
    body: 'Scoped conversation',
  });
  const reader = await enrol(w.fixture.db.app, w.fixture.business, 'scope_blind_reader');
  await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
    await grantTo(tx, reader, 'read', { kind: 'business', id: null }, false, 'conversation');
    await grantTo(tx, reader, 'read', { kind: 'record', id: other });
  });
  expect((await w.as(reader, 'task.read', { recordId: scoped })).status).toBe(403);
  await w.age(conversationId, 2);
  expect(await wrap(conversationId)).toMatchObject({ ok: true, written: true });
  const answer = await w.as(reader, 'conversation.read', { conversationId });
  expect(answer.status).toBe(200);
  expect(JSON.stringify(answer.body)).not.toContain(scoped);
  expect((answer.body['conversation'] as { scope: unknown }).scope).toBeNull();
  // The owner, who may read the task, still sees it.
  const own = await w.as(w.owner, 'conversation.read', { conversationId });
  expect(JSON.stringify(own.body)).toContain(scoped);
}

describe('Sol OW-031 proofs, real isolated Postgres and local replay provider', () => {
  beforeAll(async () => {
    c = await createControls('solow031');
    w = await conversationWorld(c);
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await setConversationWindow(tx, 7);
      await grantTo(tx, w.owner, 'share');
    });
  }, 180_000);
  afterAll(async () => {
    await w?.drop();
  });
  it('Sol proof, criterion 2: client-to-client wrap-up pointers respect the reader task boundary', async () => {
    const [one, two] = [randomUUID(), randomUUID()];
    await addClient(w.fixture.db.app, w.fixture.business, one, w.owner);
    await addClient(w.fixture.db.app, w.fixture.business, two, w.owner);
    const scoped = await task('client one scope');
    await setClient(scoped, one);
    const conversationId = await started(w, w.owner, {
      scope: { kind: 'task', id: scoped },
      body: 'Client one conversation',
    });
    const foreign = await task('client two private work', conversationId);
    await setClient(foreign, two);
    const clients = await w.fixture.db.admin.execute<{ client: string }>(
      'select uuid_7::text as client from public.records where id = any($1::uuid[])',
      [[scoped, foreign]],
    );
    expect(clients.map((row) => row.client).toSorted()).toEqual([one, two].toSorted());
    const reader = await enrol(w.fixture.db.app, w.fixture.business, 'client_one_reader');
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await grantTo(tx, reader, 'read', { kind: 'record', id: scoped }, false, 'conversation');
      await grantTo(tx, reader, 'read', { kind: 'record', id: scoped });
    });
    expect((await w.as(reader, 'task.read', { recordId: foreign })).status).toBe(403);
    await w.age(conversationId, 2);
    expect(await wrap(conversationId)).toMatchObject({ ok: true, written: true });
    const answer = await w.as(reader, 'conversation.read', { conversationId });
    expect(answer.status).toBe(200);
    expect(JSON.stringify(answer.body)).not.toContain(foreign);
  });

  it(
    'a business-wide conversation reader without task:read on the scope task gets no scope id',
    scopeBlindReader,
  );
});
