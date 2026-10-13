// SPDX-License-Identifier: AGPL-3.0-only
//
// A question and a purge of its conversation's task, at once, on two
// connections, in both orders. The purge bumps the conversation's context
// epoch under its row lock and the question reads the epoch from the row it
// holds `for update`, so the question lands in the epoch on the side of the
// purge it was kept on: asked before, it stays in the old epoch with the task
// it was asked about, and no later question carries it; asked after, it is in
// the new epoch on a conversation with no task left.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { waitingOn } from '../support/lock-waits.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detail } from './aw-03-fixture.ts';
import {
  composedOn,
  epochsOf,
  epochWorld,
  marksOf,
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

const PURGE_BUMP = 'context_epoch = context_epoch + 1';
const MESSAGE_HOLD = 'body_purged_at, scope_record_id from conversations';
const MESSAGE_KEEP = 'insert into conversation_messages';

let c: EpochWorld;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  c = await epochWorld('question_purge_race');
}, 180_000);

afterAll(async () => {
  await c?.drop();
});

/** A conversation opened on a task, then the task trashed for the purge. */
async function trashedConversation(): Promise<Opened> {
  const o = await openedOnTask(c);
  await trashed(c, o);
  return o;
}

/** The question `body` sent through its own connection, with no exchange, as a promise. */
function asked(o: Opened, database: Parameters<typeof composedOn>[1], body: string) {
  return ownerOn(c, composedOn(c.fixture, database), 'conversation.message', {
    operationId: randomUUID(),
    conversationId: o.conversationId,
    body,
  });
}

/** The kept question with this body. */
async function questionOf(o: Opened, body: string) {
  const { messages } = await epochsOf(c.fixture, o.conversationId);
  const found = messages.find((m) => m.body === body);
  if (found === undefined) throw new Error('the question was not kept');
  return found;
}

it.skipIf(serverUrl === undefined)(
  'a question that waits behind a purge holding the conversation lands in the new epoch with no task',
  async () => {
    const o = await trashedConversation();
    const purge = stepped(c.fixture.db.appUrl, PURGE_BUMP, 'hold-after');
    const second = stepped(c.fixture.db.appUrl, 'never-matched', 'hold-after');
    try {
      const purging = purgeOn(c, composedOn(c.fixture, purge.database));
      await purge.reached;
      const body = `after-${randomUUID()}`;
      const asking = asked(o, second.database, body);
      await waitingOn(c.fixture.db.admin, 'transactionid', MESSAGE_HOLD);
      purge.release();
      expect((await purging).status).toBe(200);
      const answer = await asking;
      expect(answer.status).toBe(200);
      const after = await epochsOf(c.fixture, o.conversationId);
      expect(after).toMatchObject({ epoch: 1, detached: true });
      const question = await questionOf(o, body);
      expect(question.epoch).toBe(1);
      expect(String(detail(answer)['messageId'])).toBe(question.id);
      // Kept with no task left, so no page was judged for it.
      expect(await marksOf(c.fixture, question.id)).toEqual([]);
      expect(await sentForNext(c, o.conversationId)).not.toContain(o.canary);
    } finally {
      await purge.close();
      await second.close();
    }
  },
);

it.skipIf(serverUrl === undefined)(
  'a purge that waits behind a question holding the conversation leaves the question in the old epoch, cut',
  async () => {
    const o = await trashedConversation();
    const message = stepped(c.fixture.db.appUrl, MESSAGE_KEEP, 'hold-after');
    const second = stepped(c.fixture.db.appUrl, 'never-matched', 'hold-after');
    try {
      const body = `before-${randomUUID()}`;
      const asking = asked(o, message.database, body);
      await message.reached;
      const purging = purgeOn(c, composedOn(c.fixture, second.database));
      await waitingOn(c.fixture.db.admin, 'transactionid', PURGE_BUMP);
      message.release();
      expect((await asking).status).toBe(200);
      expect((await purging).status).toBe(200);
      expect(await epochsOf(c.fixture, o.conversationId)).toMatchObject({
        epoch: 1,
        detached: true,
      });
      const question = await questionOf(o, body);
      expect(question.epoch).toBe(0);
      // Asked on the trashed task, it is marked refused for its page too.
      expect(await marksOf(c.fixture, question.id)).toEqual(['NOT_FOUND']);
      const sent = await sentForNext(c, o.conversationId);
      expect(sent).not.toContain(o.canary);
      expect(sent).not.toContain(body);
    } finally {
      await message.close();
      await second.close();
    }
  },
);

it.skipIf(serverUrl === undefined)(
  'a question holding the conversation from its first read keeps the old epoch while a purge waits for the row',
  async () => {
    const o = await trashedConversation();
    const message = stepped(c.fixture.db.appUrl, MESSAGE_HOLD, 'hold-after');
    const second = stepped(c.fixture.db.appUrl, 'never-matched', 'hold-after');
    try {
      const body = `held-${randomUUID()}`;
      const asking = asked(o, message.database, body);
      await message.reached;
      const purging = purgeOn(c, composedOn(c.fixture, second.database));
      await waitingOn(c.fixture.db.admin, 'transactionid', PURGE_BUMP);
      message.release();
      expect((await asking).status).toBe(200);
      expect((await purging).status).toBe(200);
      const after = await epochsOf(c.fixture, o.conversationId);
      expect(after).toMatchObject({ epoch: 1, detached: true });
      expect(after.messages.filter((m) => m.body === body)).toHaveLength(1);
      const question = await questionOf(o, body);
      // The task was trashed when the question read it: judged and marked, and cut.
      expect(question.epoch).toBe(0);
      expect(await marksOf(c.fixture, question.id)).toEqual(['NOT_FOUND']);
      expect(await sentForNext(c, o.conversationId)).not.toContain(body);
    } finally {
      await message.close();
      await second.close();
    }
  },
);

it.skipIf(serverUrl === undefined)(
  'a conversation started on a task while its purge holds it is refused and keeps nothing at the default epoch',
  async () => {
    const o = await trashedConversation();
    const purge = stepped(c.fixture.db.appUrl, PURGE_BUMP, 'hold-after');
    const second = stepped(c.fixture.db.appUrl, 'never-matched', 'hold-after');
    try {
      const purging = purgeOn(c, composedOn(c.fixture, purge.database));
      await purge.reached;
      const body = `start-${randomUUID()}`;
      const started = await ownerOn(
        c,
        composedOn(c.fixture, second.database),
        'conversation.start',
        {
          operationId: randomUUID(),
          body,
          scope: { kind: 'task', id: o.taskId },
        },
      );
      expect(started.status).not.toBe(200);
      purge.release();
      expect((await purging).status).toBe(200);
      expect(
        await c.w.count('select count(*) from public.conversation_messages where body = $1', [
          body,
        ]),
      ).toBe(0);
    } finally {
      await purge.close();
      await second.close();
    }
  },
);
