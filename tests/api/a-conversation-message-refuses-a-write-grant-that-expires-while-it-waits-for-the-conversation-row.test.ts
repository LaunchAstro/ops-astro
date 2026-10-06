// SPDX-License-Identifier: AGPL-3.0-only
//
// `conversation.message` is admitted on the owner's `conversation:write`
// grant, then waits for the conversation's row lock before it writes
// (`conversations.ts` `messageConversation`). A grant that expires during that
// wait no longer counts: the message is refused and nothing is kept (#444,
// the class sweep of Sol PRV-oa-1035-R1 F1).
//
// The conversation row is held on another connection, which holds no grant;
// the message is seen waiting on that holder with its transaction begun before
// the grant's expiry; the holder lets go once the database clock is past it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { blockedBefore, holdRow, waitPast } from '../support/lock-wait-race.ts';
import {
  conversationWorld,
  detail,
  expiringSoon,
  type ConversationWorld,
} from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)(
  'a conversation grant expiring while a message waits',
  () => {
    let w: ConversationWorld;
    beforeAll(async () => {
      w = await conversationWorld('message_grant_expiry');
    }, 180_000);
    afterAll(async () => {
      await w?.drop();
    });

    it('a conversation message refuses a write grant that expires while it waits for the conversation row', async () => {
      const person = w.colleague;
      const opened = await w.as(person, 'conversation.start', { body: 'Before the expiry' });
      const conversationId = String(detail(opened)['conversationId']);
      const db = w.fixture.db;
      // The owner's only covering conversation:write grant, ending in three seconds.
      const { expiry } = await expiringSoon(w, person.personId, 'conversation', 'write');
      const messages =
        'select count(*) as n from public.conversation_messages where conversation_id = $1';
      const before = await w.count(messages, [conversationId]);
      const held = await holdRow(
        db,
        'select id from public.conversations where id = $1 for update',
        [conversationId],
      );
      const sending = w.as(person, 'conversation.message', {
        conversationId,
        body: 'Sent across the expiry',
      });
      let startedLive = false;
      try {
        startedLive = await blockedBefore(db, held, expiry);
        await waitPast(db, expiry);
      } finally {
        await held.letGo();
      }
      const answer = await sending;
      expect({
        startedLive,
        status: answer.status,
        code: answer.body['code'],
        messages: await w.count(messages, [conversationId]),
      }).toEqual({ startedLive: true, status: 403, code: 'SCOPE_NOT_GRANTED', messages: before });
    }, 30_000);
  },
);
