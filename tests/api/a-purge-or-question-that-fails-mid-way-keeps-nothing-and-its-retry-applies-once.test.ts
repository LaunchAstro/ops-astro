// SPDX-License-Identifier: AGPL-3.0-only
//
// A purge or a question that fails part way, its transaction rolled back or
// the process serving it dead with its connection, keeps nothing: no epoch
// bump without the scope dropped and the task gone, and no question kept
// without the epoch it was asked in. Sent again with the same operation id it
// applies once, and once more it replays what was kept, the epoch bumped once.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detail } from './aw-03-fixture.ts';
import {
  composedOn,
  epochsOf,
  epochWorld,
  openedOnTask,
  ownerOn,
  purgeOn,
  sentForNext,
  stepped,
  trashed,
  type EpochWorld,
  type Opened,
} from './conversation-epoch-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let c: EpochWorld;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  c = await epochWorld('purge_message_crash');
}, 180_000);

afterAll(async () => {
  await c?.drop();
});

type Failure = 'rolled back' | 'process died';
const FAILURES: readonly Failure[] = ['rolled back', 'process died'];

/** `send` run on a connection that fails right after the statement naming `marker`. */
async function failedAt(
  marker: string,
  failure: Failure,
  send: (database: Parameters<typeof composedOn>[1]) => Promise<{ readonly status: number }>,
): Promise<void> {
  const how = failure === 'rolled back' ? 'fail-after' : 'hold-after';
  const step = stepped(c.fixture.db.appUrl, marker, how);
  try {
    const sending = send(step.database);
    await step.reached;
    if (failure === 'process died') await step.crash(c.fixture);
    expect((await sending).status).not.toBe(200);
  } finally {
    await step.close();
  }
}

/** Whether the task's row is still there. */
async function taskKept(o: Opened): Promise<boolean> {
  const rows = await c.fixture.db.admin.execute('select 1 from public.records where id = $1', [
    o.taskId,
  ]);
  return rows.length === 1;
}

const PURGE_STEPS = [
  ['the scope dropped and the epoch bumped', 'context_epoch = context_epoch + 1'],
  ['the task deleted', 'delete from public.live_changes'],
] as const;

const MESSAGE_STEPS = [
  ['the conversation row held', 'body_purged_at, scope_record_id from conversations'],
  ['the question inserted', 'insert into conversation_messages'],
  ['the activity moved', 'update conversations set last_activity_at'],
] as const;

describe.skipIf(serverUrl === undefined)('a purge that fails part way', () => {
  it.each(
    PURGE_STEPS.flatMap(([step, marker]) =>
      FAILURES.map((failure) => [step, failure, marker] as const),
    ),
  )(
    'a purge failing after %s, %s, keeps the task, the scope and the epoch, and its retry purges once',
    async (_step, failure, marker) => {
      const o = await openedOnTask(c);
      await trashed(c, o);
      const operationId = randomUUID();
      await failedAt(marker, failure, (database) =>
        purgeOn(c, composedOn(c.fixture, database), operationId),
      );
      expect(await epochsOf(c.fixture, o.conversationId)).toMatchObject({
        epoch: 0,
        detached: false,
      });
      expect(await taskKept(o)).toBe(true);
      const retried = await purgeOn(c, c.w.api, operationId);
      expect(detail(retried)['purgedIds']).toContain(o.taskId);
      // The answer lost after the commit: sent again, it replays and bumps nothing.
      const replayed = await purgeOn(c, c.w.api, operationId);
      expect(detail(replayed)).toEqual(detail(retried));
      expect(await epochsOf(c.fixture, o.conversationId)).toMatchObject({
        epoch: 1,
        detached: true,
      });
      expect(await taskKept(o)).toBe(false);
      expect(await sentForNext(c, o.conversationId)).not.toContain(o.canary);
    },
  );
});

/** A conversation whose task was purged, so a question kept now carries epoch 1. */
async function purgedConversation(): Promise<Opened> {
  const o = await openedOnTask(c);
  await trashed(c, o);
  expect((await purgeOn(c, c.w.api)).status).toBe(200);
  return o;
}

describe.skipIf(serverUrl === undefined)('a question that fails part way', () => {
  it.each(
    MESSAGE_STEPS.flatMap(([step, marker]) =>
      FAILURES.map((failure) => [step, failure, marker] as const),
    ),
  )(
    'a question failing after %s, %s, keeps nothing, and its retry keeps it once in the current epoch',
    async (_step, failure, marker) => {
      const o = await purgedConversation();
      const sent = {
        operationId: randomUUID(),
        conversationId: o.conversationId,
        body: `retried-${randomUUID()}`,
      };
      await failedAt(marker, failure, (database) =>
        ownerOn(c, composedOn(c.fixture, database), 'conversation.message', sent),
      );
      const before = await epochsOf(c.fixture, o.conversationId);
      expect(before.epoch).toBe(1);
      expect(before.messages.filter((m) => m.body === sent.body)).toEqual([]);
      const retried = await ownerOn(c, c.unanswered, 'conversation.message', sent);
      const replayed = await ownerOn(c, c.unanswered, 'conversation.message', sent);
      expect(detail(replayed)['messageId']).toBe(detail(retried)['messageId']);
      const after = await epochsOf(c.fixture, o.conversationId);
      const kept = after.messages.filter((m) => m.body === sent.body);
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({ id: detail(retried)['messageId'], epoch: 1 });
    },
  );
});
