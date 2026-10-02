-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0056 the agent's reply names the message it answers (AW-03's exchange).
--
-- A person's message is kept by its command; the agent's answer comes after
-- that command commits, through the broker, and is kept as a message of its
-- own with the role 'agent'. `answers_message_id` names the person's message
-- it answers, in the same conversation (the key includes the conversation),
-- and a message has at most one reply: a repeat of the same request finds the
-- reply already kept and answers with it, never a second.
--
-- Only an agent message answers, and only one: a person's message has no
-- `answers_message_id`. The table's grants already cover the column (0049:
-- select, insert and delete to the application), and the purge deletes every
-- message of a conversation in one statement, so a reply and its question go
-- together.

alter table public.conversation_messages
  add column answers_message_id uuid;

alter table public.conversation_messages
  add constraint conversation_messages_conversation_id_key
    unique (business_id, conversation_id, id),
  add constraint conversation_messages_answers_fkey
    foreign key (business_id, conversation_id, answers_message_id)
    references public.conversation_messages (business_id, conversation_id, id),
  add constraint conversation_messages_answer_is_agent
    check (answers_message_id is null or role = 'agent');

create unique index conversation_messages_one_reply
  on public.conversation_messages (business_id, conversation_id, answers_message_id)
  where answers_message_id is not null;
