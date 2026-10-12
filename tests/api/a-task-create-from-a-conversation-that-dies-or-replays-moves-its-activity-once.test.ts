// SPDX-License-Identifier: AGPL-3.0-only
//
// A task created from a conversation moves the conversation's last activity
// in the create's own transaction, and only there. A create that dies after
// that write leaves the activity where it was and no task; its retry, with the
// same operation id, is the one create; a replay of it answers the stored
// answer and moves nothing, so a wrap-up written after the create still covers
// the conversation. The conversation named in upper case is the same
// conversation.
//
// The create dies after its write to the conversation: its audit event waits
// on the audit chain's lock, held on another connection, and the waiting
// statement is cancelled there.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeWrapUp } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, instantOf, waiterOf } from '../support/lock-wait-race.ts';
import {
  CODE_REVISION,
  conversationWorld,
  setConversationWindow,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'api/a-task-create-from-a-conversation-that-dies-or-replays-moves-its-activity-once: DATABASE_URL is unset, so nothing below ran.',
  );
}

interface ServedWrapUp {
  readonly version: number;
  readonly items: readonly { key: string; pointers: readonly { id: string }[] }[];
}

// eslint-disable-next-line max-lines-per-function -- one world, three cases
describe.skipIf(serverUrl === undefined)('a task create that dies or replays', () => {
  let w: ConversationWorld;

  const wrap = async (conversationId: string) =>
    await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: CODE_REVISION }),
    );
  const activity = async (conversationId: string): Promise<string> =>
    await instantOf(
      w.fixture.db,
      'select last_activity_at::text as at from public.conversations where id = $1',
      [conversationId],
    );
  const titled = async (title: string): Promise<number> =>
    await w.count(`select count(*) as n from public.records where data ->> 'title' = $1`, [title]);
  const tasksCreated = async (conversationId: string): Promise<readonly string[]> => {
    const read = await w.as(w.owner, 'conversation.read', { conversationId });
    expect(read.status).toBe(200);
    const wrapUp = read.body['wrapUp'] as ServedWrapUp;
    return (
      wrapUp.items
        .find((item) => item.key === 'tasks_created')
        ?.pointers.map((pointer) => pointer.id) ?? []
    );
  };

  beforeAll(async () => {
    w = await conversationWorld('task_create_dies');
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await setConversationWindow(tx, 7);
    });
  }, 180_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('a create dying after its write leaves the activity unmoved and no task; its retry is the one create', async () => {
    const conversationId = await started(w, w.owner, { body: 'Make a task, then die.' });
    await w.age(conversationId, 8);
    const before = await activity(conversationId);
    const operationId = randomUUID();
    const title = 'made by a create that died';
    const body = { operationId, fields: { title }, conversationId };

    const chain = await hold(w.fixture.db, async (execute) => {
      await execute('select pg_advisory_xact_lock(hashtextextended($1::uuid::text, 0))', [
        w.fixture.business,
      ]);
    });
    const dying = w.as(w.owner, 'task.create', body).catch((cause: unknown) => cause);
    try {
      await waiterOf(w.fixture.db, chain);
      // The waiter is past its own write to the conversation, and is cancelled there.
      const cancelled = await w.fixture.db.admin.execute<{ readonly cancelled: boolean }>(
        `select pg_cancel_backend(a.pid) as cancelled from pg_stat_activity a
          where a.datname = current_database() and a.wait_event_type = 'Lock'
            and $1::int = any(pg_blocking_pids(a.pid))
            and exists (select 1 from pg_locks l
                         where l.pid = a.pid and l.relation = 'public.conversations'::regclass
                           and l.mode = 'RowExclusiveLock' and l.granted)`,
        [chain.pid],
      );
      expect(cancelled.map((row) => row.cancelled)).toEqual([true]);
    } finally {
      await chain.letGo();
    }
    const died = await dying;
    expect((died as { status?: number }).status).not.toBe(200);
    expect({ activity: await activity(conversationId), tasks: await titled(title) }).toEqual({
      activity: before,
      tasks: 0,
    });

    const retried = await w.as(w.owner, 'task.create', body);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    const taskId = (retried.body as { recordId: string }).recordId;
    await w.age(conversationId, 8);
    expect(await wrap(conversationId)).toEqual({ ok: true, version: 1, written: true });
    expect(await tasksCreated(conversationId)).toEqual([taskId]);
  });

  it('a replayed create answers the stored answer, makes no second task, and leaves its wrap-up covering', async () => {
    const conversationId = await started(w, w.owner, { body: 'Make a task, then again.' });
    const title = 'made once, replayed';
    const body = { operationId: randomUUID(), fields: { title }, conversationId };
    const first = await w.as(w.owner, 'task.create', body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await w.age(conversationId, 8);
    expect(await wrap(conversationId)).toEqual({ ok: true, version: 1, written: true });
    const covered = await activity(conversationId);

    const replayed = await w.as(w.owner, 'task.create', body);
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
    expect((replayed.body as { recordId: string }).recordId).toBe(
      (first.body as { recordId: string }).recordId,
    );
    expect({
      tasks: await titled(title),
      activity: await activity(conversationId),
      wrapUp: await wrap(conversationId),
    }).toEqual({
      tasks: 1,
      activity: covered,
      wrapUp: { ok: true, version: 1, written: false },
    });
  });

  it('a create naming its conversation in upper case is activity in that conversation', async () => {
    const conversationId = await started(w, w.owner, { body: 'Name me in capitals.' });
    await w.age(conversationId, 8);
    expect(await wrap(conversationId)).toEqual({ ok: true, version: 1, written: true });
    const created = await w.as(w.owner, 'task.create', {
      fields: { title: 'made from a capitalised conversation id' },
      conversationId: conversationId.toUpperCase(),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const taskId = (created.body as { recordId: string }).recordId;
    expect(await wrap(conversationId)).toEqual({ ok: false, reason: 'not_quiet' });
    await w.age(conversationId, 8);
    expect(await wrap(conversationId)).toEqual({ ok: true, version: 2, written: true });
    expect(await tasksCreated(conversationId)).toEqual([taskId]);
  });
});
