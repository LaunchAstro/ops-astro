-- SPDX-License-Identifier: AGPL-3.0-only
--
-- One model call per conversation message, held by storage (#1531).
--
-- A conversation call named its conversation and not the message it answers,
-- so the same message handed to the exchange again on another API instance
-- (a browser retry, a second Vercel function) made a second call: the
-- exchange de-duplicated only inside one process. A call now names its
-- message, and one message has at most one call. The exchange inserts with
-- the message and, finding one already there, answers from that call's state
-- without asking the model (`callModelInConversation`).
--
-- The key names the business and the call's own conversation, so a call
-- never points at another conversation's message (0099's
-- `conversation_messages_conversation_id_key`). A purge
-- deletes the conversation's messages (`purgeConversation`); the call stays
-- as the record of what was asked and loses only its pointer, so the key
-- sets that one column to null. A task call names no message.

alter table public.model_calls
  add column conversation_message_id uuid,
  add constraint model_calls_message_fkey
    foreign key (business_id, conversation_id, conversation_message_id)
    references public.conversation_messages (business_id, conversation_id, id)
    on delete set null (conversation_message_id),
  add constraint model_calls_message_is_a_conversations
    check (conversation_message_id is null or conversation_id is not null);

create unique index model_calls_one_per_message_idx
  on public.model_calls (business_id, conversation_message_id)
  where conversation_message_id is not null;
