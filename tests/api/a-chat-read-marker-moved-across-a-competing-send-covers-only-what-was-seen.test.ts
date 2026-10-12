// SPDX-License-Identifier: AGPL-3.0-only
//
// `chat.mark_read` reads the conversation's messages and the clock and moves
// the reader's marker in one statement under the conversation's lock
// (`team/conversations.ts`). Each case puts a send's write at that lock on a
// second connection, ends the mark_read between its write and its commit, or
// presents the same mark_read again after a newer message.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeComment } from '../../packages/core-records/src/tasks/comments.ts';
import {
  lockConversation,
  readConversationTypes,
} from '../../packages/core-records/src/team/conversations.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { diesAtItsRegisterRow, keptBy } from '../support/dies-at-the-audit-chain.ts';
import { createChatWorld, type ChatWorld } from './c71-d-world.ts';
import { freshConversation, seenBy, stepClockBack } from './chat-race-world.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a chat read marker moved under its conversation lock',
  // eslint-disable-next-line max-lines-per-function -- one world, the races that share it
  () => {
    let chat: ChatWorld;
    beforeAll(async () => {
      chat = await createChatWorld('chatmarkrace');
    }, 600_000);
    afterAll(async () => {
      await chat?.harness.close();
    });

    it('a mark_read that waited on a message sent into the millisecond it read covers only the message it saw', async () => {
      const { world } = chat.harness;
      const { reader, conversationId } = await freshConversation(chat, 'mark-race');
      const { ats } = await seenBy(chat, reader, conversationId);
      // No marker ahead of the first message: the held send lands in its millisecond.
      await world.db.admin.execute(
        `update public.team_conversation_members set last_read_at = null
          where business_id = $1 and conversation_id = $2`,
        [world.alpha, conversationId],
      );
      const restore = await stepClockBack(chat);
      const send = await hold(world.db.appUrl, world.alpha, async (tx) => {
        const types = await readConversationTypes(tx);
        if (types === undefined) throw new Error('conversation types absent');
        await lockConversation(tx, conversationId);
        await writeComment(tx, types.commentTypeId, {
          taskId: null,
          conversationId,
          authorActorId: world.ada.actorId ?? '',
          commentType: 'note',
          audience: 'direct',
          body: 'sent while the marker waited',
          source: 'api',
        });
      }).finally(restore);
      const marking = chat.as(reader, 'chat.mark_read', { conversationId, upTo: ats[0] });
      try {
        await waitingOn(world.db.admin, 'advisory', 'pg_advisory_xact_lock');
      } finally {
        await send.letGo();
      }
      const marked = await marking;
      expect(marked.status, marked.text).toBe(200);
      const seen = await seenBy(chat, reader, conversationId);
      expect({
        tied: seen.ats[1] === seen.ats[0],
        bodies: seen.bodies,
        unread: seen.unread,
      }).toEqual({
        tied: true,
        bodies: ['first to mark-race', 'sent while the marker waited'],
        unread: 1,
      });
    });

    it('a mark_read that dies at its register row leaves the marker where it was, and the same mark_read again moves it once', async () => {
      const { world } = chat.harness;
      const { reader, conversationId } = await freshConversation(chat, 'mark-crash');
      const { ats } = await seenBy(chat, reader, conversationId);
      const body = { operationId: randomUUID(), conversationId, upTo: ats[0] };
      const mark = async () => await chat.as(reader, 'chat.mark_read', body);
      // A marker move writes no applied event: its register row is its last write.
      const attempt = { actorId: reader.actorId ?? '', command: 'chat.mark_read', ...body };
      const died = await diesAtItsRegisterRow(world.db, world.alpha, attempt, mark);
      expect(died.ended).toBe(1);
      expect(died.answer?.status).not.toBe(200);
      const before = await seenBy(chat, reader, conversationId);
      expect({
        lastRead: before.lastRead,
        unread: before.unread,
        kept: await keptBy(world.db.admin, world.alpha, body.operationId),
      }).toEqual({ lastRead: null, unread: 1, kept: { operations: 0, applied: 0, refused: 0 } });
      const retried = await mark();
      expect(retried.status, retried.text).toBe(200);
      expect((await mark()).body).toEqual(retried.body);
      expect({
        unread: (await seenBy(chat, reader, conversationId)).unread,
        operations: (await keptBy(world.db.admin, world.alpha, body.operationId)).operations,
      }).toEqual({ unread: 0, operations: 1 });
    });

    it('the same mark_read presented again after a newer message answers as before and covers nothing more', async () => {
      const { world } = chat.harness;
      const { reader, conversationId } = await freshConversation(chat, 'mark-again');
      const { ats } = await seenBy(chat, reader, conversationId);
      const body = { operationId: randomUUID(), conversationId, upTo: ats[0] };
      const first = await chat.as(reader, 'chat.mark_read', body);
      expect(first.status, first.text).toBe(200);
      const newer = await chat.send(world.ada, reader, 'newer than the marker');
      expect(newer.status, newer.text).toBe(200);
      const again = await chat.as(reader, 'chat.mark_read', body);
      expect(again.body).toEqual(first.body);
      expect({
        unread: (await seenBy(chat, reader, conversationId)).unread,
        operations: (await keptBy(world.db.admin, world.alpha, body.operationId)).operations,
      }).toEqual({ unread: 1, operations: 1 });
    });
  },
);
