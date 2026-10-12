// SPDX-License-Identifier: AGPL-3.0-only
//
// A model's reply and a purge of its conversation's task, at once, on two
// connections, in both orders. The question was asked while the task was live
// and its answer is kept after the model replied. Kept behind the purge, the
// reply is in the new epoch but its question is not, so it is cut with it;
// kept ahead of the purge, both are in the old epoch; and when the purge holds
// a grant the reply's `nowait` hold covers, the reply rolls back and nothing is
// kept. No later question carries either.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { grantTo } from '../commands/fixture.ts';
import { waitingOn } from '../support/lock-waits.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { CONVERSATION, detail } from './aw-03-fixture.ts';
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
  type StepHow,
} from './conversation-epoch-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const PURGE_BUMP = 'context_epoch = context_epoch + 1';
const REPLY_HOLD = 'select body_purged_at from conversations';

let c: EpochWorld;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  c = await epochWorld('reply_purge_race');
}, 180_000);

afterAll(async () => {
  await c?.drop();
});

/** A question kept on the live task with nothing answering it yet. */
async function unansweredQuestion(o: Opened): Promise<string> {
  const kept = await ownerOn(c, c.unanswered, 'conversation.message', {
    operationId: randomUUID(),
    conversationId: o.conversationId,
    body: `question-${randomUUID()}`,
  });
  return String(detail(kept)['messageId']);
}

/** The question's exchange on its own connection, stopped at the reply's row lock. */
async function replyStopped(o: Opened, messageId: string, how: StepHow) {
  const reply = stepped(c.fixture.db.appUrl, REPLY_HOLD, how);
  const seen = c.model.provider.seen.length;
  const replying = c.model.exchange(reply.database, c.fixture.business, c.w.owner.presented, {
    conversationId: o.conversationId,
    messageId,
  });
  await Promise.race([
    reply.reached,
    replying.then(() => {
      throw new Error('the reply finished without reaching its row lock');
    }),
  ]);
  // The model was asked while the task was live.
  expect(c.model.provider.seen).toHaveLength(seen + 1);
  return { reply, replying };
}

/** What was kept: the question and its reply's epochs, and the conversation's. */
async function keptFor(o: Opened, messageId: string) {
  const after = await epochsOf(c.fixture, o.conversationId);
  const question = after.messages.find((m) => m.id === messageId);
  const reply = after.messages.find((m) => m.answers === messageId);
  return { after, question, reply };
}

/** The next question's request names neither the old question nor the reply. */
async function nextCarriesNeither(o: Opened, messageId: string, replyBody?: string) {
  const { question } = await keptFor(o, messageId);
  const sent = await sentForNext(c, o.conversationId);
  expect(sent).not.toContain(o.canary);
  expect(sent).not.toContain(question?.body);
  if (replyBody !== undefined) expect(sent).not.toContain(replyBody);
}

it.skipIf(serverUrl === undefined)(
  'a reply that waits behind a purge holding the conversation is kept in the new epoch and cut with its question',
  async () => {
    const o = await openedOnTask(c);
    const messageId = await unansweredQuestion(o);
    const { reply, replying } = await replyStopped(o, messageId, 'hold-before');
    const purge = stepped(c.fixture.db.appUrl, PURGE_BUMP, 'hold-after');
    try {
      await trashed(c, o);
      const purging = purgeOn(c, composedOn(c.fixture, purge.database));
      await purge.reached;
      reply.release();
      await waitingOn(c.fixture.db.admin, 'transactionid', REPLY_HOLD);
      purge.release();
      expect((await purging).status).toBe(200);
      expect(await replying).toMatchObject({ answered: true });
      const kept = await keptFor(o, messageId);
      expect(kept.after).toMatchObject({ epoch: 1, detached: true });
      expect([kept.question?.epoch, kept.reply?.epoch]).toEqual([0, 1]);
      await nextCarriesNeither(o, messageId, kept.reply?.body);
    } finally {
      await reply.close();
      await purge.close();
    }
  },
);

it.skipIf(serverUrl === undefined)(
  'a reply holding the conversation ahead of a purge is kept in the old epoch with its question, both cut',
  async () => {
    const o = await openedOnTask(c);
    const messageId = await unansweredQuestion(o);
    const { reply, replying } = await replyStopped(o, messageId, 'hold-after');
    const second = stepped(c.fixture.db.appUrl, 'never-matched', 'hold-after');
    try {
      await trashed(c, o);
      const purging = purgeOn(c, composedOn(c.fixture, second.database));
      await waitingOn(c.fixture.db.admin, 'transactionid', PURGE_BUMP);
      reply.release();
      expect(await replying).toMatchObject({ answered: true });
      expect((await purging).status).toBe(200);
      const kept = await keptFor(o, messageId);
      expect(kept.after).toMatchObject({ epoch: 1, detached: true });
      expect([kept.question?.epoch, kept.reply?.epoch]).toEqual([0, 0]);
      await nextCarriesNeither(o, messageId, kept.reply?.body);
    } finally {
      await reply.close();
      await second.close();
    }
  },
);

it.skipIf(serverUrl === undefined)(
  'a reply whose grant hold meets the purge revoking a covering grant rolls back and keeps nothing',
  async () => {
    const o = await openedOnTask(c);
    // A conversation grant scoped to the task: the purge revokes it, holding its row.
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      await grantTo(tx, c.w.owner, 'write', { kind: 'record', id: o.taskId }, false, CONVERSATION);
    });
    const messageId = await unansweredQuestion(o);
    const { reply, replying } = await replyStopped(o, messageId, 'hold-after');
    const second = stepped(c.fixture.db.appUrl, 'never-matched', 'hold-after');
    try {
      await trashed(c, o);
      const purging = purgeOn(c, composedOn(c.fixture, second.database));
      await waitingOn(c.fixture.db.admin, 'transactionid', PURGE_BUMP);
      reply.release();
      expect(await replying).toBeNull();
      const purged = await purging;
      expect(purged.status).toBe(200);
      expect(detail(purged)['grantsRevoked']).toBe(1);
      const kept = await keptFor(o, messageId);
      expect(kept.after).toMatchObject({ epoch: 1, detached: true });
      expect(kept.question?.epoch).toBe(0);
      expect(kept.reply).toBeUndefined();
      await nextCarriesNeither(o, messageId);
    } finally {
      await reply.close();
      await second.close();
    }
  },
);
