// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #412, OW-031 criterion 2: Sol's proof (titles named by behaviour, bodies unchanged)
// (R/sol/proofs/OW-031-4126931d1.patch), with the setup and helpers it uses;
// the file's other criteria are not this issue's.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeWrapUp } from '../../packages/core-commands/src/index.ts';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import {
  conversationWorld,
  setConversationWindow,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import { createControls, type Controls } from './controls-fixture.ts';
import { addClient, enrol, grantTo } from '../commands/fixture.ts';
import { serverUrl } from '../acceptance/world.ts';

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
  const items = (answer.body['wrapUp'] as { items: { key: string; fact: string }[] }).items;
  expect(items.find((item) => item.key === 'scope')?.fact).toBe('Opened with no scope');
  // The owner, who may read the task, still sees it.
  const own = await w.as(w.owner, 'conversation.read', { conversationId });
  expect(JSON.stringify(own.body)).toContain(scoped);
}

/** A conversation started from a task carries the task's title as its subject, and as its title when none is sent. */
async function subjectBlindReader(): Promise<void> {
  const hidden = `hidden task title ${randomUUID()}`;
  const scoped = await task(hidden);
  const scope = { kind: 'task', id: scoped };
  const conversations = [
    await started(w, w.owner, { scope, subject: hidden, title: hidden, body: 'From the page' }),
    await started(w, w.owner, { scope, subject: hidden, body: 'From the API, untitled' }),
  ];
  const reader = await enrol(w.fixture.db.app, w.fixture.business, 'subject_blind_reader');
  await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
    await grantTo(tx, reader, 'read', { kind: 'business', id: null }, false, 'conversation');
  });
  expect((await w.as(reader, 'task.read', { recordId: scoped })).status).toBe(403);
  for (const conversationId of conversations) {
    // eslint-disable-next-line no-await-in-loop -- each conversation is read in turn
    const answer = await w.as(reader, 'conversation.read', { conversationId });
    expect(answer.status).toBe(200);
    expect(JSON.stringify(answer.body)).not.toContain(hidden);
    expect(answer.body['conversation']).toMatchObject({ subject: null, title: 'New conversation' });
    // The owner, who may read the task, still sees its title.
    // eslint-disable-next-line no-await-in-loop -- each conversation is read in turn
    const own = await w.as(w.owner, 'conversation.read', { conversationId });
    expect(own.body['conversation']).toMatchObject({ subject: hidden, title: hidden });
  }
}

/** The owner's tab row follows the same rule once the owner may no longer read the scope task. */
async function listAfterTaskLost(): Promise<void> {
  const hidden = `task title the owner loses ${randomUUID()}`;
  const scoped = await task(hidden);
  const starter = await enrol(w.fixture.db.app, w.fixture.business, 'task_losing_owner');
  const taskGrant = await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
    await grantTo(tx, starter, 'write', { kind: 'business', id: null }, false, 'conversation');
    return await grantTo(tx, starter, 'read', { kind: 'record', id: scoped });
  });
  const scope = { kind: 'task', id: scoped };
  await started(w, starter, { scope, subject: hidden, body: 'Started while readable' });
  await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
    expect(await revokeGrant(tx, taskGrant)).not.toBeNull();
  });
  const list = await w.as(starter, 'conversation.list', {});
  expect(list.status).toBe(200);
  expect(JSON.stringify(list.body)).not.toContain(hidden);
  expect(list.body['conversations']).toMatchObject([{ title: 'New conversation' }]);
}

describe.skipIf(serverUrl === undefined)('wrap-up pointers on a real database', () => {
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
  it('client-to-client wrap-up pointers respect the reader task boundary', async () => {
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

  it('a reader who may not read the scope task never sees its title', subjectBlindReader);
  it('an owner who loses the scope task no longer lists its title', listAfterTaskLost);
});
