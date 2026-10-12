// SPDX-License-Identifier: AGPL-3.0-only
//
// A reply the model gave to a question asked before its task was purged, but
// kept after the purge committed, is cut from the conversation's context with
// its question: a later question sends neither in `earlier`.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  connect,
  writeBusinessSetting,
  type Database,
} from '../../packages/core-records/src/index.ts';
import { readReplayAnswer } from '../../packages/core-connectors/src/replay.ts';
import { addClient, grantTo } from '../commands/fixture.ts';
import { conversationWorld, detail } from '../api/aw-03-fixture.ts';
import { composedWith, localModel } from '../api/aw-03-exchange-fixture.ts';
import { createApiFixture } from '../api/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { latch } from '../support/lock-wait-race.ts';

type World = Awaited<ReturnType<typeof conversationWorld>>;
type Fixture = Awaited<ReturnType<typeof createApiFixture>>;

/** `database`, pausing once at the reply's conversation-row read until `released` opens. */
function pausing(
  database: Database,
  reached: ReturnType<typeof latch<void>>,
  released: ReturnType<typeof latch<void>>,
): Database {
  let pause = true;
  const delayed: Database = {
    log: database.log,
    close: async () => await database.close(),
    withBusiness: async (businessId, run) =>
      await database.withBusiness(
        businessId,
        async (tx) =>
          await run({
            ...tx,
            query: async (sql, values) => {
              if (pause && sql.includes('select body_purged_at from conversations')) {
                pause = false;
                reached.open();
                await released.promise;
              }
              return await tx.query(sql, values);
            },
          }),
      ),
  };
  return delayed;
}

/** The owner may share and manage, and trashed tasks are purged at once. */
async function letOwnerPurge(fixture: Fixture, w: World) {
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

/** A conversation world whose exchange pauses once, just before the reply's conversation-row lock. */
async function pausedExchange(canary: string) {
  const model = await localModel((body) => {
    const answer = readReplayAnswer(body);
    return answer === undefined ? undefined : { ...answer, text: canary };
  });
  const fixture = await createApiFixture('late_context');
  const exchangeDb = connect(fixture.db.appUrl);
  const reached = latch();
  const released = latch();
  const delayed = pausing(exchangeDb, reached, released);
  const w = await conversationWorld({
    fixture,
    api: composedWith(
      fixture,
      async (_database, businessId, presented, asked) =>
        await model.exchange(delayed, businessId, presented, asked),
    ),
  });
  await letOwnerPurge(fixture, w);
  return { model, fixture, exchangeDb, reached, released, w };
}

/** Links a client to the task, trashes it and purges it, through the API. */
async function linkTrashAndPurge(
  w: World,
  fixture: Fixture,
  made: Awaited<ReturnType<World['as']>>,
  taskId: string,
) {
  const clientId = randomUUID();
  await addClient(fixture.db.app, fixture.business, clientId, w.owner);
  const linked = await w.as(w.owner, 'task.set_party', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: made.body['revision'],
    fields: { client: clientId },
  });
  expect(linked.status).toBe(200);
  const trashed = await w.as(w.owner, 'task.trash', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: linked.body['revision'],
  });
  expect(trashed.status).toBe(200);
  await fixture.db.admin.execute(
    "update public.records set deleted_at = now() - interval '1 hour' where business_id = $1 and id = $2",
    [fixture.business, taskId],
  );
  const purged = await w.as(w.owner, 'task.purge', { operationId: randomUUID() });
  expect(purged.status).toBe(200);
  expect(detail(purged)['purgedIds']).toContain(taskId);
}

/** Whether the question predates the conversation's context start and its reply follows it. */
async function timingOf(fixture: Fixture, conversationId: string) {
  const [timing] = await fixture.db.admin.execute<{
    question_before: boolean;
    answer_after: boolean;
  }>(
    `select q.created_at < c.context_from as question_before,
          r.created_at > c.context_from as answer_after
     from public.conversations c
     join public.conversation_messages q on q.conversation_id = c.id and q.role = 'person'
     join public.conversation_messages r on r.answers_message_id = q.id
    where c.id = $1`,
    [conversationId],
  );
  return timing;
}

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a reply to a pre-purge question kept after purge is not sent in later context',
  async () => {
    const canary = `old-task-answer-${randomUUID()}`;
    const { model, fixture, exchangeDb, reached, released, w } = await pausedExchange(canary);
    let opening: ReturnType<typeof w.as> | undefined;
    try {
      const made = await w.as(w.owner, 'task.create', { fields: { title: 'task before client' } });
      expect(made.status).toBe(200);
      const taskId = String(made.body['recordId']);
      opening = w.as(w.owner, 'conversation.start', {
        body: 'answer about the task before its client was linked',
        scope: { kind: 'task', id: taskId },
      });
      await Promise.race([
        reached.promise,
        opening.then(() => {
          throw new Error('the answer completed without reaching the scheduled pause');
        }),
      ]);
      expect(model.provider.seen).toHaveLength(1);
      await linkTrashAndPurge(w, fixture, made, taskId);
      released.open();
      const opened = await opening;
      expect(opened.body['reply']).toMatchObject({ answered: true });
      const conversationId = String(detail(opened)['conversationId']);
      const timing = await timingOf(fixture, conversationId);
      expect(timing).toEqual({ question_before: true, answer_after: true });
      const seen = model.provider.seen.length;
      const next = await w.as(w.owner, 'conversation.message', {
        conversationId,
        body: 'a new question after the purge committed',
      });
      expect(next.body['reply']).toMatchObject({ answered: true });
      expect(model.provider.seen).toHaveLength(seen + 1);
      expect(model.provider.seen.at(-1)?.body).not.toContain(canary);
    } finally {
      released.open();
      await opening?.catch(() => null);
      await exchangeDb.close();
      await w.drop();
      await model.close();
    }
  },
  180_000,
);
