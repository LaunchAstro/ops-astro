// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatConversationView, ChatMessageView } from '../../packages/core-wire/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createChatWorld, type ChatWorld } from './c71-d-world.ts';
import { idOf } from './c71-d-lock-world.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'chat read markers under a backwards database clock',
  () => {
    let chat: ChatWorld;
    beforeAll(async () => {
      chat = await createChatWorld('sol1403clock');
    }, 180_000);
    afterAll(async () => {
      await chat?.harness.close();
    });

    it('a backwards database clock cannot hide a new message behind a read marker', async () => {
      const { world } = chat.harness;
      const first = await chat.send(world.ada, chat.tess, 'seen before the clock step');
      expect(first.status, first.text).toBe(200);
      const conversationId = idOf(first);
      // Both members joined before the simulated clock value, so this isolates the marker ordering.
      await world.db.admin.execute(
        `update public.team_conversation_members set joined_at = joined_at - interval '1 day'
        where business_id = $1 and conversation_id = $2`,
        [world.alpha, conversationId],
      );
      const before = await chat.as(chat.tess, 'chat.messages', { conversationId });
      const at = (before.body['messages'] as ChatMessageView[]).at(-1)?.at;
      const marked = await chat.as(chat.tess, 'chat.mark_read', { conversationId, upTo: at });
      expect(marked.status, marked.text).toBe(200);
      const [original] = await world.db.admin.execute<{ definition: string }>(
        `select pg_get_functiondef('pg_catalog.clock_timestamp()'::regprocedure) as definition`,
      );
      if (original === undefined) throw new Error('clock definition absent');
      try {
        // Only this suite's throwaway database sees the clock change. All product SQL still runs.
        await world.db.admin.execute(`create or replace function pg_catalog.clock_timestamp()
        returns timestamptz language sql volatile as $$ select now() - interval '1 minute' $$`);
        const next = await chat.send(world.ada, chat.tess, 'unseen after the clock step');
        expect(next.status, next.text).toBe(200);
      } finally {
        await world.db.admin.execute(original.definition);
      }
      const read = await chat.as(chat.tess, 'chat.messages', { conversationId });
      expect((read.body['messages'] as ChatMessageView[]).map((m) => m.body)).toContain(
        'unseen after the clock step',
      );
      const listed = await chat.as(chat.tess, 'chat.conversations');
      expect(
        (listed.body['conversations'] as ChatConversationView[]).find(
          (row) => row.conversationId === conversationId,
        )?.unread,
      ).toBe(1);
    });
  },
);
