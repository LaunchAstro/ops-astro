// SPDX-License-Identifier: AGPL-3.0-only
//
// A purge that began before a question was asked on its task, and commits
// after it was answered, still cuts that question and its answer from the
// conversation's later context: the cut is an ordering under the
// conversation's row lock, not a comparison of the purge's clock.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  connect,
  writeBusinessSetting,
  type Database,
} from '../../packages/core-records/src/index.ts';
import { addClient, grantTo } from '../commands/fixture.ts';
import { conversationWorld, detail } from './aw-03-fixture.ts';
import { composedWith, localModel } from './aw-03-exchange-fixture.ts';
import { authorised, createApiFixture, post, tokenFor } from './fixture.ts';
import { personPath } from './controls-fixture.ts';
import { latch } from '../support/lock-wait-race.ts';

type Latch = ReturnType<typeof latch<void>>;

/**
 * `database`, each transaction paused once after BEGIN, before any authority or
 * record lock, until `released` opens. PostgreSQL's now() is already fixed
 * there. No stored timestamp is forged.
 */
function pausedAfterBegin(database: Database, reached: Latch, released: Latch): Database {
  return {
    log: database.log,
    close: async () => await database.close(),
    withBusiness: async (businessId, run) =>
      await database.withBusiness(businessId, async (tx) => {
        await tx.query('select now()');
        reached.open();
        await released.promise;
        return await run(tx);
      }),
  };
}

/** The owner may share and manage, and trashed tasks are purged at once. */
async function letOwnerPurge(
  fixture: Awaited<ReturnType<typeof createApiFixture>>,
  w: Awaited<ReturnType<typeof conversationWorld>>,
) {
  await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    await grantTo(tx, w.owner, 'manage');
    await grantTo(tx, w.owner, 'share');
    expect(
      await writeBusinessSetting(tx, {
        key: 'retention_window_days',
        owningOperation: 'settings.set_retention_window',
        value: 0,
      }),
    ).not.toBeUndefined();
  });
}

/**
 * Posts `name` through `api`, whose transaction pauses after BEGIN, and waits
 * until it has paused; the request answers once its latch is released.
 */
async function pausedPost(
  api: Parameters<typeof post>[0],
  name: Parameters<typeof personPath>[0],
  body: Readonly<Record<string, unknown>>,
  w: Awaited<ReturnType<typeof conversationWorld>>,
  reached: Latch,
) {
  const request = post(
    api,
    personPath(name),
    body,
    authorised(await tokenFor(w.owner.presented.subject)),
  );
  await Promise.race([
    reached.promise,
    request.then(() => {
      throw new Error(`${name} did not pause`);
    }),
  ]);
  return { request };
}

/** Whether the conversation is detached, and its cut falls before the question. */
async function timingOf(
  fixture: Awaited<ReturnType<typeof createApiFixture>>,
  conversationId: string,
  messageId: string,
) {
  const [timing] = await fixture.db.admin.execute<{
    cutoff_before_question: boolean;
    detached: boolean;
  }>(
    `select c.scope_record_id is null as detached,
          c.context_from <= q.created_at as cutoff_before_question
     from public.conversations c
     join public.conversation_messages q on q.conversation_id = c.id
    where c.id = $1 and q.id = $2`,
    [conversationId, messageId],
  );
  return timing;
}

/** A model, the API, and two connections whose transactions pause after BEGIN. */
async function cutoffWorld() {
  const model = await localModel();
  const fixture = await createApiFixture('purge_cutoff');
  const w = await conversationWorld({ fixture, api: composedWith(fixture, model.exchange) });
  const purgeDb = connect(fixture.db.appUrl);
  const trashDb = connect(fixture.db.appUrl);
  const trashReached = latch<void>();
  const trashReleased = latch<void>();
  const reached = latch<void>();
  const released = latch<void>();
  const pending: { trashing?: ReturnType<typeof post>; purging?: ReturnType<typeof post> } = {};
  return {
    model,
    fixture,
    w,
    purgeDb,
    trashDb,
    trashReached,
    trashReleased,
    reached,
    released,
    pending,
    delayed: pausedAfterBegin(purgeDb, reached, released),
    delayedTrash: pausedAfterBegin(trashDb, trashReached, trashReleased),
  };
}

type CutoffWorld = Awaited<ReturnType<typeof cutoffWorld>>;

/** A task, then its trash and the purge, each paused after BEGIN. */
async function trashAndPurgePaused(c: CutoffWorld) {
  const { fixture, w } = c;
  await letOwnerPurge(fixture, w);
  const made = await w.as(w.owner, 'task.create', { fields: { title: 'task before client' } });
  expect(made.status).toBe(200);
  const taskId = String(made.body['recordId']);
  // Trash starts first, so its deleted_at precedes the purge's retention
  // cutoff even though it commits later. Both delays hold no product locks.
  c.pending.trashing = (
    await pausedPost(
      fixture.compose(undefined, undefined, c.delayedTrash),
      'task.trash',
      {
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: Number(made.body['revision']) + 1,
      },
      w,
      c.trashReached,
    )
  ).request;
  c.pending.purging = (
    await pausedPost(
      fixture.compose(undefined, undefined, c.delayed),
      'task.purge',
      { operationId: randomUUID() },
      w,
      c.reached,
    )
  ).request;
  return { made, taskId };
}

/** The question asked and answered on the task, its client linked, then the trash and purge let go. */
async function askLinkAndRelease(
  c: CutoffWorld,
  made: Awaited<ReturnType<CutoffWorld['w']['as']>>,
  taskId: string,
) {
  const { fixture, w } = c;
  const canary = `pre-purge-question-${randomUUID()}`;
  const opened = await w.as(w.owner, 'conversation.start', {
    body: canary,
    scope: { kind: 'task', id: taskId },
  });
  expect(opened.body['reply']).toMatchObject({ answered: true });
  const conversationId = String(detail(opened)['conversationId']);
  const clientId = randomUUID();
  await addClient(fixture.db.app, fixture.business, clientId, w.owner);
  const linked = await w.as(w.owner, 'task.set_party', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: made.body['revision'],
    fields: { client: clientId },
  });
  expect(linked.status).toBe(200);
  expect(linked.body['revision']).toBe(Number(made.body['revision']) + 1);
  c.trashReleased.open();
  const trashed = await c.pending.trashing;
  expect(trashed?.status).toBe(200);
  c.released.open();
  const purged = await c.pending.purging;
  expect(purged?.status).toBe(200);
  expect(purged === undefined ? [] : detail(purged)['purgedIds']).toContain(taskId);
  return { canary, conversationId, messageId: String(detail(opened)['messageId']) };
}

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a purge begun before an answered question cuts that question from later context',
  async () => {
    const c = await cutoffWorld();
    const { model, fixture, w } = c;
    try {
      const { made, taskId } = await trashAndPurgePaused(c);
      const { canary, conversationId, messageId } = await askLinkAndRelease(c, made, taskId);
      const timing = await timingOf(fixture, conversationId, messageId);
      expect(timing).toEqual({ detached: true, cutoff_before_question: true });
      const seen = model.provider.seen.length;
      const next = await w.as(w.owner, 'conversation.message', {
        conversationId,
        body: 'after purge',
      });
      expect(next.body['reply']).toMatchObject({ answered: true });
      expect(model.provider.seen).toHaveLength(seen + 1);
      expect(model.provider.seen.at(-1)?.body).not.toContain(canary);
    } finally {
      c.trashReleased.open();
      c.released.open();
      await c.pending.trashing?.catch(() => null);
      await c.pending.purging?.catch(() => null);
      await c.purgeDb.close();
      await c.trashDb.close();
      await w.drop();
      await model.close();
    }
  },
  180_000,
);
