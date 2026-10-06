// SPDX-License-Identifier: AGPL-3.0-only
//
// The click-through seed's one agent conversation (SR-1): Ada asks the agent
// a made-up question and its reply is kept, so the side panel opens on a
// question and an answer. `w` is `click-through-work.mjs`'s world.
//
// The question is the product's own `conversation.start`, as Ada. No model is
// asked: nothing here may spend or leave the machine. The reply is written as
// the exchange's `keep` writes it, under the conversation's row lock and as
// the app role, with fixed made-up words. No scope: chat about a client stays
// refused (owner line 72), and the drawer needs no task to show the answer.

import { randomUUID } from 'node:crypto';
import { lockedInstant } from '../../packages/core-runtime/src/clock.ts';

export const CHAT_TITLE = 'Newsletter ideas';
const QUESTION = 'What are three ideas for a short team newsletter this month?';
const REPLY =
  'Three ideas: a welcome to anyone new on the team, a photo from the last team day, ' +
  'and one tip for keeping the shared drive tidy.';

/** Absent, ended (the question has its reply) or stranded (it has none). */
export async function chatState(w) {
  const [found] = await w.query(
    `select exists (select from public.conversation_messages r
        where r.business_id = m.business_id and r.conversation_id = m.conversation_id
          and r.answers_message_id = m.id) as ended
       from public.conversations c
       join public.conversation_messages m on m.business_id = c.business_id
        and m.conversation_id = c.id and m.role = 'person' and m.body = $3
      where c.business_id = $1 and c.owner_actor_id = $2
      order by m.created_at limit 1`,
    [w.cast.businessId, w.cast.adminActorId, QUESTION],
  );
  if (found === undefined) return 'absent';
  return found.ended ? 'ended' : 'stranded';
}

/** Ada's question, then the agent's reply to it. */
export async function askTheAgent(w) {
  const asked = await w.as(w.admin, {
    command: 'conversation.start',
    title: CHAT_TITLE,
    body: QUESTION,
  });
  await w.database.withBusiness(w.cast.businessId, async (tx) => {
    await tx.query(
      'select from public.conversations where business_id = $1 and id = $2 for update',
      [tx.businessId, asked.conversationId],
    );
    // The reply and the activity at one instant, read once the lock is held.
    const at = await lockedInstant(tx);
    const inserted = await tx.query(
      `insert into public.conversation_messages
         (business_id, id, conversation_id, role, author_actor_id, body, answers_message_id,
          created_at)
       values ($1, $2, $3, 'agent', $4, $5, $6, $7::text::timestamptz)
       on conflict (business_id, conversation_id, answers_message_id)
         where answers_message_id is not null
       do nothing
       returning id`,
      [
        tx.businessId,
        randomUUID(),
        asked.conversationId,
        w.cast.adminActorId,
        REPLY,
        asked.messageId,
        at,
      ],
    );
    if (inserted.length === 0) return;
    await tx.query(
      `update public.conversations
          set last_activity_at = greatest($3::text::timestamptz, last_activity_at)
        where business_id = $1 and id = $2`,
      [tx.businessId, asked.conversationId, at],
    );
  });
}
