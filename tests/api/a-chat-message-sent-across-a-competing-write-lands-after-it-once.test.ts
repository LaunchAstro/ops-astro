// SPDX-License-Identifier: AGPL-3.0-only
//
// A chat message's `posted_at` is read and written in one statement under its
// conversation's lock: the greatest of the clock, the conversation's latest
// message and its members' furthest read marker (`tasks/comments.ts`). Each
// case puts a second connection's write at that lock, ends the send between
// its writes and its commit, or presents the same send twice. The clock steps
// back a minute where the case needs only the read under the lock to save it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeComment } from '../../packages/core-records/src/tasks/comments.ts';
import {
  lockConversation,
  moveReadMarker,
  readConversationTypes,
} from '../../packages/core-records/src/team/conversations.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { diesAtTheAuditChain, keptBy } from '../support/dies-at-the-audit-chain.ts';
import { enrolCaller } from '../acceptance/cast.ts';
import { createChatWorld, type ChatWorld } from './c71-d-world.ts';
import { CHAT, idOf } from './c71-d-lock-world.ts';
import {
  advisoryWaiters,
  freshConversation,
  messagesSaying,
  onItsOwnInstance,
  seenBy,
  stepClockBack,
} from './chat-race-world.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a chat message stamped under its conversation lock',
  // eslint-disable-next-line max-lines-per-function -- one world, the races that share it
  () => {
    let chat: ChatWorld;
    beforeAll(async () => {
      chat = await createChatWorld('chatsendrace');
    }, 600_000);
    afterAll(async () => {
      await chat?.harness.close();
    });

    it('a message sent while a read marker move holds its conversation lands after that marker on a clock that steps back', async () => {
      const { world } = chat.harness;
      const { reader, conversationId } = await freshConversation(chat, 'marker-race');
      const marker = await hold(world.db.appUrl, world.alpha, async (tx) => {
        await lockConversation(tx, conversationId);
        await moveReadMarker(tx, conversationId, reader.personId ?? '', 'now');
      });
      let restore: (() => Promise<void>) | undefined;
      try {
        const sending = chat.send(world.ada, reader, 'sent across the marker move');
        try {
          await waitingOn(world.db.admin, 'advisory', 'pg_advisory_xact_lock');
          restore = await stepClockBack(chat);
        } finally {
          await marker.letGo();
        }
        const sent = await sending;
        expect(sent.status, sent.text).toBe(200);
      } finally {
        await restore?.();
      }
      const seen = await seenBy(chat, reader, conversationId);
      expect({ last: seen.bodies.at(-1), unread: seen.unread }).toEqual({
        last: 'sent across the marker move',
        unread: 1,
      });
    });

    it('a message sent while another message holds its conversation ranks after it on a clock that steps back', async () => {
      const { world } = chat.harness;
      const { reader, conversationId } = await freshConversation(chat, 'message-race');
      const held = await hold(world.db.appUrl, world.alpha, async (tx) => {
        const types = await readConversationTypes(tx);
        if (types === undefined) throw new Error('conversation types absent');
        await lockConversation(tx, conversationId);
        await writeComment(tx, types.commentTypeId, {
          taskId: null,
          conversationId,
          authorActorId: world.ada.actorId ?? '',
          commentType: 'note',
          audience: 'direct',
          body: 'the held message',
          source: 'api',
        });
      });
      let restore: (() => Promise<void>) | undefined;
      try {
        const sending = chat.send(world.ada, reader, 'sent behind the held message');
        try {
          await waitingOn(world.db.admin, 'advisory', 'pg_advisory_xact_lock');
          restore = await stepClockBack(chat);
        } finally {
          await held.letGo();
        }
        expect((await sending).status).toBe(200);
      } finally {
        await restore?.();
      }
      const seen = await seenBy(chat, reader, conversationId);
      // The held message as a reading that held only it shows it: its millisecond, one seen.
      const heldAt = seen.ats.at(-2)?.replace(/(\.\d{3})\d{3}Z$/u, '$1Z');
      const marked = await chat.as(reader, 'chat.mark_read', { conversationId, upTo: heldAt });
      expect(marked.status, marked.text).toBe(200);
      const after = await seenBy(chat, reader, conversationId);
      expect({ bodies: after.bodies.slice(1), unread: after.unread }).toEqual({
        bodies: ['the held message', 'sent behind the held message'],
        unread: 1,
      });
    });

    it('a chat send that dies after writing its message leaves nothing, and the same send again posts it once', async () => {
      const { world } = chat.harness;
      const { reader, conversationId } = await freshConversation(chat, 'send-crash');
      const body = {
        operationId: randomUUID(),
        teammateId: reader.personId,
        body: 'dies before its commit',
      };
      const send = async () => await chat.as(world.ada, 'chat.send_direct', body);
      const died = await diesAtTheAuditChain(world.db, world.alpha, send);
      expect(died.ended).toBe(1);
      expect(died.answer?.status).not.toBe(200);
      expect({
        messages: await messagesSaying(chat, body.body),
        kept: await keptBy(world.db.admin, world.alpha, body.operationId),
        unread: (await seenBy(chat, reader, conversationId)).unread,
      }).toEqual({ messages: 0, kept: { operations: 0, applied: 0, refused: 0 }, unread: 1 });
      const retried = await send();
      expect(retried.status, retried.text).toBe(200);
      const again = await send();
      expect(again.body).toEqual(retried.body);
      expect({
        messages: await messagesSaying(chat, body.body),
        applied: (await keptBy(world.db.admin, world.alpha, body.operationId)).applied,
        unread: (await seenBy(chat, reader, conversationId)).unread,
      }).toEqual({ messages: 1, applied: 1, unread: 2 });
    });

    it('the same chat send presented twice at once posts one message and both answers name it', async () => {
      const { world } = chat.harness;
      const { reader, conversationId } = await freshConversation(chat, 'send-twice');
      const body = { operationId: randomUUID(), teammateId: reader.personId, body: 'sent twice' };
      const conversation = await hold(world.db.appUrl, world.alpha, async (tx) => {
        await lockConversation(tx, conversationId);
      });
      const send = async () => await onItsOwnInstance(chat, world.ada, 'chat.send_direct', body);
      let answers: Promise<Awaited<ReturnType<typeof send>>[]>;
      try {
        const first = send();
        await advisoryWaiters(chat, 1);
        const second = send();
        await advisoryWaiters(chat, 2);
        answers = Promise.all([first, second]);
      } finally {
        await conversation.letGo();
      }
      const [one, two] = await answers;
      expect([one?.status, two?.status]).toEqual([200, 200]);
      expect(two?.body).toEqual(one?.body);
      expect({
        messages: await messagesSaying(chat, body.body),
        applied: (await keptBy(world.db.admin, world.alpha, body.operationId)).applied,
      }).toEqual({ messages: 1, applied: 1 });
    });

    it('a member added while a message sent on a clock that stepped back holds the group reads nothing sent before they joined', async () => {
      const { world } = chat.harness;
      const newcomer = await enrolCaller(world.db, world.alpha, 'alpha', 'group-newcomer', CHAT);
      const members = [chat.tess.personId, world.mia.personId];
      const started = await chat.as(world.ada, 'chat.start_group', { name: 'Clock crew', members });
      expect(started.status, started.text).toBe(200);
      const conversationId = idOf(started);
      const before = { conversationId, body: 'said before the clock step' };
      expect((await chat.as(world.ada, 'chat.send_group', before)).status).toBe(200);
      const restore = await stepClockBack(chat);
      try {
        const held = await hold(world.db.appUrl, world.alpha, async (tx) => {
          const types = await readConversationTypes(tx);
          if (types === undefined) throw new Error('conversation types absent');
          await lockConversation(tx, conversationId);
          await writeComment(tx, types.commentTypeId, {
            taskId: null,
            conversationId,
            authorActorId: world.ada.actorId ?? '',
            commentType: 'note',
            audience: 'group',
            body: 'sent before the newcomer joined',
            source: 'api',
          });
        });
        const add = { conversationId, add: [newcomer.personId] };
        const adding = chat.as(world.ada, 'chat.change_members', add);
        try {
          await waitingOn(world.db.admin, 'advisory', 'pg_advisory_xact_lock');
        } finally {
          await held.letGo();
        }
        const added = await adding;
        expect(added.status, added.text).toBe(200);
      } finally {
        await restore();
      }
      const read = await chat.as(newcomer, 'chat.messages', { conversationId });
      expect(read.status, read.text).toBe(200);
      const bodies = (read.body['messages'] as { readonly body: string }[]).map((m) => m.body);
      expect(bodies).toEqual([]);
    });
  },
);
