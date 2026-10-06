// SPDX-License-Identifier: AGPL-3.0-only
//
// Owner line 72 for a question kept on a client's task: it is marked refused
// in the transaction that keeps it, so it asks no model though no exchange
// ran then, a client link committed while it was kept included; and a repeat
// that waited on the page while its twin refused still sees that refusal.
// Through a fresh Postgres and the replay stand-in on loopback, the exchange
// called directly so the test decides when it reads the page.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markRefusedForPage } from '../../packages/core-commands/src/commands/conversation-context.ts';
import { slotOf, TASK_SPINE, withSession } from '../../packages/core-records/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { addClient, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { createApiFixture, type Answer } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, its polling and the three cases
describe.skipIf(serverUrl === undefined)('a question kept on a client’s task', () => {
  let w: ConversationWorld;
  let model: LocalModel;

  beforeAll(async () => {
    model = await localModel();
    const fixture = await createApiFixture('kept_client_mark');
    w = await conversationWorld({
      fixture,
      api: composedWith(fixture, async () => await Promise.resolve(null)),
    });
  }, 180_000);

  afterAll(async () => {
    await model?.close();
    await w?.drop();
  });

  /** Waits until `n` backends wait on a lock. */
  async function waitingOnLocks(n: number): Promise<void> {
    for (let tries = 0; tries < 400; tries += 1) {
      // eslint-disable-next-line no-await-in-loop -- polling the server
      const found = await w.count(
        `select count(*) as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
        [],
      );
      if (found >= n) return;
      // eslint-disable-next-line no-await-in-loop
      await sleep(25);
    }
    throw new Error(`${String(n)} backends never waited on a lock`);
  }

  /** A task linked to a client, and the owner's share grant to link it. */
  async function clientTask(): Promise<{ taskId: string; linked: Answer }> {
    const { db, business } = w.fixture;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, w.owner, 'share');
    });
    const clientId = randomUUID();
    await addClient(db.app, business, clientId, w.owner);
    const made = await w.as(w.owner, 'task.create', {
      fields: { title: `Client's ${randomUUID()}` },
    });
    const taskId = String(made.body['recordId']);
    const linked = await w.as(w.owner, 'task.set_party', {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: made.body['revision'],
      fields: { client: clientId },
    });
    expect(linked.status).toBe(200);
    return { taskId, linked };
  }

  const unlink = async (taskId: string, linked: Answer): Promise<void> => {
    const cleared = await w.as(w.owner, 'task.set_party', {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: linked.body['revision'],
      fields: { client: null },
    });
    expect(cleared.status).toBe(200);
  };

  it('kept on a client’s task: a question no exchange answered stays refused once the client is cleared', async () => {
    const { db, business } = w.fixture;
    const { taskId, linked } = await clientTask();
    const opened = await w.as(w.owner, 'conversation.start', {
      body: `CANARY-${randomUUID()} about the client`,
      scope: { kind: 'task', id: taskId },
    });
    const asked = {
      conversationId: String(detail(opened)['conversationId']),
      messageId: String(detail(opened)['messageId']),
    };
    await unlink(taskId, linked);
    const before = model.provider.seen.length;
    const answer = await model.exchange(db.app, business, w.owner.presented, asked);
    expect(answer).toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
    expect(model.provider.seen.length).toBe(before);
  });

  it('a repeat that waited on the page while its twin refused and the client was cleared stays refused', async () => {
    const { db, business } = w.fixture;
    const made = await w.as(w.owner, 'task.create', { fields: { title: `Twin ${randomUUID()}` } });
    const taskId = String(made.body['recordId']);
    const opened = await w.as(w.owner, 'conversation.start', {
      body: 'What is this?',
      scope: { kind: 'task', id: taskId },
    });
    const asked = {
      conversationId: String(detail(opened)['conversationId']),
      messageId: String(detail(opened)['messageId']),
    };
    const before = model.provider.seen.length;
    const holder = connect(db.appUrl, { source: 'runtime' });
    const reader = connect(db.appUrl, { source: 'runtime' });
    let replying: Promise<unknown> | undefined;
    try {
      // The holder stands where the twin's refusal and the client's clearing hold the task.
      await holder.withBusiness(business, async (tx) => {
        await tx.query(`select id from records where business_id = $1 and id = $2 for update`, [
          business,
          taskId,
        ]);
        replying = model.exchange(reader, business, w.owner.presented, asked);
        await waitingOnLocks(1);
        await withSession(db.app, business, w.owner.presented, async (twin, session) => {
          await markRefusedForPage(twin, session, asked);
        });
      });
      expect(await replying).toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
      expect(model.provider.seen.length).toBe(before);
    } finally {
      await replying?.catch(() => null);
      await Promise.allSettled([holder, reader].map(async (one) => await one.close()));
    }
  });
  it('a client link committed while a message is kept marks it: refused once the client is cleared', async () => {
    const { db, business } = w.fixture;
    const made = await w.as(w.owner, 'task.create', {
      fields: { title: `Linked ${randomUUID()}` },
    });
    const taskId = String(made.body['recordId']);
    const opened = await w.as(w.owner, 'conversation.start', {
      body: 'before any client',
      scope: { kind: 'task', id: taskId },
    });
    const conversationId = String(detail(opened)['conversationId']);
    const clientId = randomUUID();
    await addClient(db.app, business, clientId, w.owner);
    const holder = connect(db.appUrl, { source: 'runtime' });
    let keeping: Promise<Answer> | undefined;
    try {
      // The holder stands where `task.set_party` links the client, uncommitted while the message is kept.
      await holder.withBusiness(business, async (tx) => {
        await tx.query(`select id from records where business_id = $1 and id = $2 for update`, [
          business,
          taskId,
        ]);
        await tx.query(
          `update records set ${slotOf(TASK_SPINE, 'client')} = $3 where business_id = $1 and id = $2`,
          [business, taskId, clientId],
        );
        keeping = w.as(w.owner, 'conversation.message', {
          conversationId,
          body: `CANARY-${randomUUID()} about the client`,
        });
        await waitingOnLocks(1);
      });
      const kept = await keeping;
      expect(kept?.status).toBe(200);
      await db.admin.execute(
        `update public.records set ${slotOf(TASK_SPINE, 'client')} = null where id = $1`,
        [taskId],
      );
      const asked = { conversationId, messageId: String(detail(kept as Answer)['messageId']) };
      const before = model.provider.seen.length;
      const answer = await model.exchange(db.app, business, w.owner.presented, asked);
      expect(answer).toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
      expect(model.provider.seen.length).toBe(before);
    } finally {
      await keeping?.catch(() => null);
      await holder.close();
    }
  });
});
