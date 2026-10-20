// SPDX-License-Identifier: AGPL-3.0-only
//
// #1666, review S1852-2 (Sol's proof, its steps unchanged, split into helpers for the line
// caps): a created task purged after the context is read but before the reply is kept leaves
// the snapshot without it, and the reply still keeps.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  connect,
  writeBusinessSetting,
  type Database,
} from '../../packages/core-records/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { latch } from '../support/lock-wait-race.ts';
import { detail } from './aw-03-fixture.ts';
import { block, chatWorld } from './chat-created-fixture.ts';

type World = Awaited<ReturnType<typeof chatWorld>>;

/** The app database, its first reply keep held open at `reached` until `released`. */
function pausedAtKeep(own: Database) {
  const reached = latch();
  const released = latch();
  let pause = true;
  const delayed: Database = {
    log: own.log,
    close: async () => await own.close(),
    withBusiness: async (business, run) =>
      await own.withBusiness(
        business,
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
  return { delayed, reached, released };
}

/** The owner may purge, and a trashed task is purged at once. */
async function purgeAtOnce(c: World): Promise<void> {
  await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
    await grantTo(tx, c.w.owner, 'manage');
    expect(
      await writeBusinessSetting(tx, {
        key: 'retention_window_days',
        owningOperation: 'settings.set_retention_window',
        value: 0,
      }),
    ).not.toBeUndefined();
  });
}

/** The task trashed and purged through the API. */
async function trashAndPurge(c: World, task: string): Promise<void> {
  const trashed = await c.w.as(c.w.owner, 'task.trash', {
    operationId: randomUUID(),
    recordId: task,
    expectedRevision: await c.revisionOf(task),
  });
  expect(trashed.status).toBe(200);
  const purged = await c.w.as(c.w.owner, 'task.purge', { operationId: randomUUID() });
  expect(purged.status).toBe(200);
  expect(detail(purged)['purgedIds']).toContain(task);
}

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a task purged while the model answers is dropped from the snapshot, and the reply keeps',
  async () => {
    const c = await chatWorld('purge_while_answering');
    const own = connect(c.fixture.db.appUrl);
    const { delayed, reached, released } = pausedAtKeep(own);
    let answering: Promise<unknown> | undefined;
    try {
      const { conversationId, task } = await c.created(c.w.owner, 'Task purged during answer');
      await purgeAtOnce(c);
      c.state.quiet = true;
      const { messageId } = await c.say(c.w.owner, conversationId, 'Edit the task');
      c.state.quiet = false;
      c.state.says = block('{"action":"edit","title":"Edited task"}');
      // Pause at the reply keep, after the context's transaction and the model call.
      answering = c.other.exchange(delayed, c.fixture.business, c.w.owner.presented, {
        conversationId,
        messageId,
      });
      // Attach the rejection handler before releasing the scheduled interleaving.
      const outcome = answering.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await Promise.race([
        reached.promise,
        outcome.then(() => {
          throw new Error('exchange finished without reaching the scheduled keep pause');
        }),
      ]);
      await trashAndPurge(c, task);
      released.open();
      const result = await outcome;
      expect(result).not.toHaveProperty('error');
      expect(result).toMatchObject({ value: { answered: true } });
    } finally {
      released.open();
      await answering?.catch(() => {});
      await own.close();
      await c.close();
    }
  },
  180_000,
);
