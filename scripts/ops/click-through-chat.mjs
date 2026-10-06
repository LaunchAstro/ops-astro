// SPDX-License-Identifier: AGPL-3.0-only
//
// The click-through seed's one agent conversation (SR-1): Ada asks the agent
// a made-up question and its reply is kept, so the side panel opens on a
// question and an answer. `w` is `click-through-work.mjs`'s world.
//
// The question is the product's own `conversation.start`, as Ada. No model is
// asked: nothing here may spend or leave the machine. The reply is written as
// the exchange's `keep` writes it, in Ada's session, under the conversation's
// row lock and only while she still holds conversation:write, with fixed
// made-up words. No scope: chat about a client stays refused (owner line 72),
// and the drawer needs no task to show the answer.

import { randomUUID } from 'node:crypto';
import { holdsOwnConversations } from '../../packages/core-commands/src/commands/conversations.ts';
import {
  sessionEndedSince,
  subjectsOf,
  withSession,
} from '../../packages/core-records/src/index.ts';
import { holdCoveringGrants, lockedInstant } from '../../packages/core-runtime/src/index.ts';

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
  const kept = await withSession(
    w.database,
    w.cast.businessId,
    w.cast.people[w.admin],
    async (tx, session) => {
      const at = await stillHers(tx, session, asked);
      if (at === null) {
        throw new Error(
          `click-through-seed: '${CHAT_TITLE}': Ada no longer holds conversation:write; no reply kept`,
        );
      }
      await reply(tx, session, asked, at);
      return true;
    },
  );
  if (kept !== true) {
    throw new Error(
      `click-through-seed: '${CHAT_TITLE}': Ada's session refused ${JSON.stringify(kept)}`,
    );
  }
}

/**
 * What `keep` asks before it writes, in its order: Ada's own conversation,
 * its body kept and its row locked; her session not ended; her
 * conversation:write grant held for share and live at the instant read once
 * the locks are held, so a revocation committed first is seen and one after
 * waits for the reply. That instant, or null when she may not reply.
 */
async function stillHers(tx, session, asked) {
  const [held] = await tx.query(
    `select body_purged_at from public.conversations
      where business_id = $1 and id = $2 and owner_actor_id = $3 for update`,
    [tx.businessId, asked.conversationId, session.actorId],
  );
  if (held === undefined || held.body_purged_at !== null) {
    throw new Error(`click-through-seed: '${CHAT_TITLE}' is not Ada's kept conversation`);
  }
  if (await sessionEndedSince(tx, session)) return null;
  const grants = new Set(
    await holdCoveringGrants(tx, subjectsOf(session), 'conversation', 'nowait'),
  );
  const at = await lockedInstant(tx);
  return (await holdsOwnConversations(tx, session, { at, held: grants })) ? at : null;
}

/** The reply and the activity at that one instant, as `keep` writes them. */
async function reply(tx, session, asked, at) {
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
      session.actorId,
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
}
