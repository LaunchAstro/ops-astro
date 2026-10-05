// SPDX-License-Identifier: AGPL-3.0-only
// C71-D read markers: a reader who saw both messages of one millisecond and
// marks the newest read is left with nothing unread.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatConversationView, ChatMessageView } from '../../packages/core-wire/src/index.ts';
import { createChatWorld, type ChatWorld } from './c71-d-world.ts';
import { enrolCaller } from '../acceptance/cast.ts';
import { CHAT, idOf } from './c71-d-lock-world.ts';

async function unreadOf(chat: ChatWorld, reader: { readonly token: string }, id: string) {
  const listed = await chat.as(reader, 'chat.conversations');
  expect(listed.status, listed.text).toBe(200);
  return (listed.body['conversations'] as ChatConversationView[]).find(
    (row) => row.conversationId === id,
  )?.unread;
}

describe('C71-D read markers on a shared millisecond', () => {
  let chat: ChatWorld;
  beforeAll(async () => {
    chat = await createChatWorld('prv353r21');
  }, 600_000);
  afterAll(async () => {
    await chat?.harness.close();
  });

  it('criterion 5: marking the newest of two same-millisecond messages read leaves none unread', async () => {
    const { world } = chat.harness;
    const reader = await enrolCaller(world.db, world.alpha, 'alpha', 'tie-newest-reader', CHAT);
    const first = await chat.send(world.ada, reader, 'first of the millisecond');
    expect(first.status, first.text).toBe(200);
    const conversationId = idOf(first);
    const second = await chat.send(world.ada, reader, 'second of the millisecond');
    expect(second.status, second.text).toBe(200);

    // The tieSnapshot fixture: give the second message the first's stored
    // millisecond, keeping created_at order.
    const before = await chat.as(reader, 'chat.messages', { conversationId });
    const firstAt = (before.body['messages'] as ChatMessageView[])[0]?.at;
    if (firstAt === undefined) throw new Error('first message absent');
    await world.db.admin.execute(
      `update public.records set data = jsonb_set(data, '{posted_at}', to_jsonb($2::text))
        where id = $1`,
      [(second.body['detail'] as Record<string, unknown>)['commentId'], firstAt],
    );

    const read = await chat.as(reader, 'chat.messages', { conversationId });
    expect(read.status, read.text).toBe(200);
    const messages = read.body['messages'] as ChatMessageView[];
    expect(messages.map((m) => m.body)).toEqual([
      'first of the millisecond',
      'second of the millisecond',
    ]);
    expect(messages[1]?.at).toBe(messages[0]?.at);
    const newest = messages[1]?.at;

    const marked = await chat.as(reader, 'chat.mark_read', { conversationId, upTo: newest });
    expect(marked.status, marked.text).toBe(200);
    const afterMark = await unreadOf(chat, reader, conversationId);

    const again = await chat.as(reader, 'chat.mark_read', { conversationId, upTo: newest });
    expect(again.status, again.text).toBe(200);
    const afterRepeat = await unreadOf(chat, reader, conversationId);

    expect({ afterMark, afterRepeat }, 'both messages were seen').toEqual({
      afterMark: 0,
      afterRepeat: 0,
    });
  });
});
