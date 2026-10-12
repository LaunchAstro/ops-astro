// SPDX-License-Identifier: AGPL-3.0-only
//
// A model's reply that fails part way through being kept, its transaction
// rolled back or the process serving it dead with its connection, keeps
// nothing. Asked again, the reply is kept once, in the epoch of the
// conversation's row it held, and asked once more it is answered from what
// was kept, the model not asked again. A conversation whose task was purged
// sends that reply later, and nothing from before the purge.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detail } from './aw-03-fixture.ts';
import {
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
  c = await epochWorld('reply_crash');
}, 180_000);

afterAll(async () => {
  await c?.drop();
});

const STEPS = [
  ['the conversation row held', 'select body_purged_at from conversations'],
  ['the reply inserted', 'insert into conversation_messages'],
  ['the activity moved', 'update conversations set last_activity_at'],
] as const;

type Failure = 'rolled back' | 'process died';
const FAILURES: readonly Failure[] = ['rolled back', 'process died'];

/** A conversation whose task was purged, and a question kept in it with nothing answering yet. */
async function questionAfterPurge(): Promise<{ readonly o: Opened; readonly messageId: string }> {
  const o = await openedOnTask(c);
  await trashed(c, o);
  expect((await purgeOn(c, c.w.api)).status).toBe(200);
  const kept = await ownerOn(c, c.unanswered, 'conversation.message', {
    operationId: randomUUID(),
    conversationId: o.conversationId,
    body: `after-purge-${randomUUID()}`,
  });
  return { o, messageId: String(detail(kept)['messageId']) };
}

/** The question's exchange on a connection that fails right after the statement naming `marker`. */
async function failedAt(
  asked: { conversationId: string; messageId: string },
  marker: string,
  failure: Failure,
) {
  const step = stepped(
    c.fixture.db.appUrl,
    marker,
    failure === 'rolled back' ? 'fail-after' : 'hold-after',
  );
  try {
    const replying = c.model.exchange(
      step.database,
      c.fixture.business,
      c.w.owner.presented,
      asked,
    );
    await step.reached;
    if (failure === 'process died') {
      const failing = expect(replying).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
      await step.crash(c.fixture);
      await failing;
    } else {
      await expect(replying).rejects.toThrow(marker);
    }
  } finally {
    await step.close();
  }
}

/** The question's exchange, on the world's own connection. */
const exchanged = async (asked: { conversationId: string; messageId: string }) =>
  await c.model.exchange(c.fixture.db.app, c.fixture.business, c.w.owner.presented, asked);

describe.skipIf(serverUrl === undefined)('a reply that fails part way', () => {
  it.each(
    STEPS.flatMap(([step, marker]) => FAILURES.map((failure) => [step, failure, marker] as const)),
  )(
    'a reply failing after %s, %s, keeps nothing, and asked again it is kept once in the current epoch',
    async (_step, failure, marker) => {
      const { o, messageId } = await questionAfterPurge();
      const asked = { conversationId: o.conversationId, messageId };
      await failedAt(asked, marker, failure);
      const before = await epochsOf(c.fixture, o.conversationId);
      expect(before.epoch).toBe(1);
      expect(before.messages.filter((m) => m.answers === messageId)).toEqual([]);
      const first = await exchanged(asked);
      expect(first).toMatchObject({ answered: true });
      const seen = c.model.provider.seen.length;
      const again = await exchanged(asked);
      expect(again).toEqual(first);
      expect(c.model.provider.seen).toHaveLength(seen);
      const after = await epochsOf(c.fixture, o.conversationId);
      const replies = after.messages.filter((m) => m.answers === messageId);
      expect(replies).toHaveLength(1);
      expect(replies[0]?.epoch).toBe(1);
      const sent = await sentForNext(c, o.conversationId);
      expect(sent).toContain(replies[0]?.body);
      expect(sent).not.toContain(o.canary);
    },
  );
});
