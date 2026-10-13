// SPDX-License-Identifier: AGPL-3.0-only
//
// The exchange's context read and a purge of the conversation's task, at
// once, on two connections. The read finds the question and its page task in
// one statement and the earlier messages of the current epoch in another; a
// purge that commits between them, or holds the conversation while the read
// runs, leaves the read seeing the task gone or the old epoch whole. It never
// sends the old epoch's messages with the task dropped: refused, the model is
// asked nothing; read after the purge, it is sent nothing from before it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detail } from './aw-03-fixture.ts';
import {
  composedOn,
  epochWorld,
  marksOf,
  openedOnTask,
  ownerOn,
  purgeOn,
  stepped,
  trashed,
  type EpochWorld,
  type Opened,
} from './conversation-epoch-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const QUESTION_FOUND = 'select c.owner_person_id, m.body, c.scope_record_id';
const PURGE_BUMP = 'context_epoch = context_epoch + 1';

let c: EpochWorld;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  c = await epochWorld('context_read_purge');
}, 180_000);

afterAll(async () => {
  await c?.drop();
});

/** A conversation on a live task: its first question answered, a second kept with no answer. */
async function unanswered(): Promise<{ readonly o: Opened; readonly messageId: string }> {
  const o = await openedOnTask(c);
  const kept = await ownerOn(c, c.unanswered, 'conversation.message', {
    operationId: randomUUID(),
    conversationId: o.conversationId,
    body: `pending-${randomUUID()}`,
  });
  return { o, messageId: String(detail(kept)['messageId']) };
}

/** The exchange for the question, on `database`. */
const exchangeOn = (database: Parameters<typeof composedOn>[1], o: Opened, messageId: string) =>
  c.model.exchange(database, c.fixture.business, c.w.owner.presented, {
    conversationId: o.conversationId,
    messageId,
  });

describe.skipIf(serverUrl === undefined)('the context read and a purge at once', () => {
  it('a read that found the question on its task before the purge committed asks no model', async () => {
    const { o, messageId } = await unanswered();
    const read = stepped(c.fixture.db.appUrl, QUESTION_FOUND, 'hold-after');
    try {
      const seen = c.model.provider.seen.length;
      const replying = exchangeOn(read.database, o, messageId);
      await read.reached;
      await trashed(c, o);
      expect((await purgeOn(c, c.w.api)).status).toBe(200);
      read.release();
      expect(await replying).toMatchObject({ answered: false });
      expect(c.model.provider.seen).toHaveLength(seen);
      expect(await marksOf(c.fixture, messageId)).toEqual(['NOT_FOUND']);
    } finally {
      await read.close();
    }
  });

  it('a read while the purge holds the conversation uncommitted sees the old epoch and the task gone, and asks no model', async () => {
    const { o, messageId } = await unanswered();
    await trashed(c, o);
    const purge = stepped(c.fixture.db.appUrl, PURGE_BUMP, 'hold-after');
    const second = stepped(c.fixture.db.appUrl, 'never-matched', 'hold-after');
    try {
      const purging = purgeOn(c, composedOn(c.fixture, purge.database));
      await purge.reached;
      const seen = c.model.provider.seen.length;
      expect(await exchangeOn(second.database, o, messageId)).toMatchObject({ answered: false });
      expect(c.model.provider.seen).toHaveLength(seen);
      purge.release();
      expect((await purging).status).toBe(200);
      expect(await marksOf(c.fixture, messageId)).toEqual(['NOT_FOUND']);
    } finally {
      await purge.close();
      await second.close();
    }
  });

  it('a read after the purge committed sends the question with nothing from before it', async () => {
    const { o, messageId } = await unanswered();
    await trashed(c, o);
    expect((await purgeOn(c, c.w.api)).status).toBe(200);
    expect(await exchangeOn(c.fixture.db.app, o, messageId)).toMatchObject({ answered: true });
    const sent = c.model.provider.seen.at(-1)?.body ?? '';
    expect(sent).not.toContain(o.canary);
    expect(sent).not.toContain('task to be purged');
  });
});
