// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #412: Sol's PRV-oa-745-R2 proof (title named by behaviour, body
// unchanged; R/sol/proofs/PRV-oa-745-R2-e5e33a4be.patch). The list's own
// statement decides the title, so an unreadable scope task's subject never
// reaches the serving process.
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  revokeGrant,
  type Database,
  type TransactionQuery,
} from '../../packages/core-records/src/index.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { conversationWorld, started, type ConversationWorld } from './aw-03-fixture.ts';
import { serverUrl } from '../acceptance/world.ts';

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let w: ConversationWorld;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await conversationWorld('sol745r2list');
}, 180_000);
afterAll(async () => await w?.drop());

// eslint-disable-next-line max-lines-per-function -- the reviewer's proof, kept byte for byte
it('person to person listing keeps an unreadable task subject inside Postgres', async () => {
  const hidden = 'SOL745R2_UNREADABLE_TASK_SUBJECT';
  const created = await w.as(w.owner, 'task.create', { fields: { title: hidden } });
  expect(created.status).toBe(200);
  const taskId = String(created.body['recordId']);
  const starter = await enrol(w.fixture.db.app, w.fixture.business, 'list-owner');
  const taskGrant = await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
    await grantTo(tx, starter, 'write', undefined, false, 'conversation');
    return await grantTo(tx, starter, 'read', { kind: 'record', id: taskId });
  });
  await started(w, starter, {
    scope: { kind: 'task', id: taskId },
    subject: hidden,
    title: 'An independent conversation title',
    body: 'An independent message',
  });
  await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
    expect(await revokeGrant(tx, taskGrant)).not.toBeNull();
  });
  expect((await w.as(starter, 'task.read', { recordId: taskId })).status).toBe(403);
  const received: string[] = [];
  const app = w.fixture.db.app;
  const observed: Database = {
    log: app.log,
    close: async () => {},
    withBusiness: async (businessId, run) =>
      await app.withBusiness(businessId, async (tx) => {
        const watched: TransactionQuery = {
          businessId: tx.businessId,
          savepoint: tx.savepoint,
          async query<Row>(statement: string, parameters?: readonly unknown[]) {
            const rows = await tx.query<Row>(statement, parameters);
            received.push(JSON.stringify(rows));
            return rows;
          },
        };
        return await run(watched);
      }),
  };
  const answer = await executeRead(observed, w.fixture.business, starter.presented, {
    read: 'conversation.list',
  });
  expect(answer).toMatchObject({
    ok: true,
    conversations: [{ title: 'An independent conversation title' }],
  });
  expect(JSON.stringify(answer)).not.toContain(hidden);
  expect(
    received.join('\n'),
    'unreadable task subject was returned to the serving process',
  ).not.toContain(hidden);
});

/** The app database, recording every row set a query hands back. */
function watching(received: string[]): Database {
  const app = w.fixture.db.app;
  return {
    log: app.log,
    close: async () => {},
    withBusiness: async (businessId, run) =>
      await app.withBusiness(businessId, async (tx) => {
        const watched: TransactionQuery = {
          businessId: tx.businessId,
          savepoint: tx.savepoint,
          async query<Row>(statement: string, parameters?: readonly unknown[]) {
            const rows = await tx.query<Row>(statement, parameters);
            received.push(JSON.stringify(rows));
            return rows;
          },
        };
        return await run(watched);
      }),
  };
}

it('the owner reading their own conversation keeps an unreadable task subject inside Postgres', async () => {
  const hidden = 'READ_UNREADABLE_TASK_SUBJECT';
  const created = await w.as(w.owner, 'task.create', { fields: { title: hidden } });
  expect(created.status).toBe(200);
  const taskId = String(created.body['recordId']);
  const starter = await enrol(w.fixture.db.app, w.fixture.business, 'read-owner');
  const taskGrant = await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
    await grantTo(tx, starter, 'write', undefined, false, 'conversation');
    return await grantTo(tx, starter, 'read', { kind: 'record', id: taskId });
  });
  const conversationId = await started(w, starter, {
    scope: { kind: 'task', id: taskId },
    subject: hidden,
    body: 'An independent message',
  });
  await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
    expect(await revokeGrant(tx, taskGrant)).not.toBeNull();
  });
  const received: string[] = [];
  const answer = await executeRead(watching(received), w.fixture.business, starter.presented, {
    read: 'conversation.read',
    conversationId,
  });
  expect(answer).toMatchObject({
    ok: true,
    conversation: { title: 'New conversation', subject: null, scope: null },
  });
  expect(JSON.stringify(answer)).not.toContain(hidden);
  expect(received.join('\n'), 'the subject reached the serving process').not.toContain(hidden);
});
