// SPDX-License-Identifier: AGPL-3.0-only
//
// Owner line 72 at the moment the page is read: the exchange holds the
// conversation's page task for share while it checks the client and reads
// the title. A link to a client that is being written when the exchange
// reads the task makes it wait, and once that link commits the exchange
// sees the client and asks no model, so a title that was a client's when
// it was read is never sent. Through a fresh Postgres and the replay
// stand-in on loopback, the link written by `task.set_party` itself.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { addClient, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { createApiFixture, type Answer } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, its polling and the one case
describe.skipIf(serverUrl === undefined)('a page task linked to a client mid-read', () => {
  let w: ConversationWorld;
  let model: LocalModel;

  beforeAll(async () => {
    model = await localModel();
    // The API answers nothing here; the exchange is called directly, so the
    // test decides when it reads the page.
    const fixture = await createApiFixture('page_client_race');
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

  /** A task, and a person's question kept in a conversation on it, not yet answered. */
  async function scopedQuestion(title: string) {
    const made = await w.as(w.owner, 'task.create', { fields: { title } });
    const taskId = String(made.body['recordId']);
    const opened = await w.as(w.owner, 'conversation.start', {
      body: 'What is this?',
      scope: { kind: 'task', id: taskId },
    });
    expect((opened.body as Record<string, unknown>)['reply']).toBeUndefined();
    const asked = {
      conversationId: String(detail(opened)['conversationId']),
      messageId: String(detail(opened)['messageId']),
    };
    return { taskId, revision: made.body['revision'], asked };
  }

  it('owner line 72: a client link committed while the exchange waits on the page task asks no model', async () => {
    const { db, business } = w.fixture;
    const title = `Soon a client's ${randomUUID()}`;
    const { taskId, revision, asked } = await scopedQuestion(title);
    const clientId = randomUUID();
    await addClient(db.app, business, clientId, w.owner);
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, w.owner, 'share');
    });
    const before = model.provider.seen.length;
    // The holder stands where `task.set_party` takes the task's row lock: the
    // link waits behind it, and the exchange waits behind the link.
    const holder = connect(db.appUrl, { source: 'runtime' });
    // The exchange on its own connections, so it waits on the row and not on the API's pool.
    const reader = connect(db.appUrl, { source: 'runtime' });
    let linking: Promise<Answer> | undefined;
    let replying: Promise<unknown> | undefined;
    try {
      await holder.withBusiness(business, async (tx) => {
        await tx.query(`select id from records where business_id = $1 and id = $2 for update`, [
          business,
          taskId,
        ]);
        linking = w.as(w.owner, 'task.set_party', {
          operationId: randomUUID(),
          recordId: taskId,
          expectedRevision: revision,
          fields: { client: clientId },
        });
        await waitingOnLocks(1);
        replying = model.exchange(reader, business, w.owner.presented, asked);
        await waitingOnLocks(2);
      });
      expect((await linking)?.status).toBe(200);
      expect(await replying).toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
      expect(model.provider.seen.length).toBe(before);
      expect(JSON.stringify(model.provider.seen)).not.toContain(title);
    } finally {
      await linking?.catch(() => null);
      await replying?.catch(() => null);
      await Promise.allSettled([holder, reader].map(async (one) => await one.close()));
    }
  });
});
