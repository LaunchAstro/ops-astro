// SPDX-License-Identifier: AGPL-3.0-only
// C71-D read markers on the wire: a marker set among messages that share a
// millisecond comes back with its place among them, in the digits a tied
// message's `at` carries, so `lastRead`, each message's `at` and `unread`
// tell a client the same thing. A millisecond `Date` dropped the place, and a
// marker after one of two tied messages read as level with both.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatConversationView, ChatMessageView } from '../../packages/core-wire/src/index.ts';
import { createChatWorld, type ChatWorld } from './c71-d-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrolCaller } from '../acceptance/cast.ts';
import { CHAT, idOf } from './c71-d-lock-world.ts';

/** The reader's marker and unread as both reads answer them. */
async function markerOf(chat: ChatWorld, reader: { readonly token: string }, id: string) {
  const listed = await chat.as(reader, 'chat.conversations');
  expect(listed.status, listed.text).toBe(200);
  const view = (listed.body['conversations'] as ChatConversationView[]).find(
    (row) => row.conversationId === id,
  );
  const read = await chat.as(reader, 'chat.messages', { conversationId: id });
  expect(read.status, read.text).toBe(200);
  return { listed: view?.lastRead, messages: read.body['lastRead'], unread: view?.unread };
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'C71-D a read marker among tied messages',
  () => {
    let chat: ChatWorld;
    beforeAll(async () => {
      chat = await createChatWorld('tiedmarker');
    }, 600_000);
    afterAll(async () => {
      await chat?.harness.close();
    });

    it('a marker after one of two same-millisecond messages reads before the second, and after both once both are read', async () => {
      const { world } = chat.harness;
      const reader = await enrolCaller(world.db, world.alpha, 'alpha', 'tied-marker-reader', CHAT);
      const first = await chat.send(world.ada, reader, 'first of the millisecond');
      expect(first.status, first.text).toBe(200);
      const conversationId = idOf(first);
      const second = await chat.send(world.ada, reader, 'second of the millisecond');
      expect(second.status, second.text).toBe(200);

      // Give the second message the first's stored millisecond, keeping write order.
      const before = await chat.as(reader, 'chat.messages', { conversationId });
      const firstAt = (before.body['messages'] as ChatMessageView[])[0]?.at;
      if (firstAt === undefined) throw new Error('first message absent');
      await world.db.admin.execute(
        `update public.records set data = jsonb_set(data, '{posted_at}', to_jsonb($2::text))
          where id = $1`,
        [(second.body['detail'] as Record<string, unknown>)['commentId'], firstAt],
      );
      const read = await chat.as(reader, 'chat.messages', { conversationId });
      const tied = (read.body['messages'] as ChatMessageView[]).map((m) => m.at);
      expect(tied[1]).toBe(tied[0]);
      const both = tied[1] ?? '';
      expect(both).toMatch(/\.\d{3}002Z$/u);
      const one = both.replace(/002Z$/u, '001Z');

      const markedOne = await chat.as(reader, 'chat.mark_read', { conversationId, upTo: one });
      expect(markedOne.status, markedOne.text).toBe(200);
      const afterOne = await markerOf(chat, reader, conversationId);

      const markedBoth = await chat.as(reader, 'chat.mark_read', { conversationId, upTo: both });
      expect(markedBoth.status, markedBoth.text).toBe(200);
      const afterBoth = await markerOf(chat, reader, conversationId);

      expect({ afterOne, afterBoth }).toEqual({
        afterOne: { listed: one, messages: one, unread: 1 },
        afterBoth: { listed: both, messages: both, unread: 0 },
      });
    });
  },
);
