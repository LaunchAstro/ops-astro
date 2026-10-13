-- SPDX-License-Identifier: AGPL-3.0-only
--
-- One model call per conversation message (#1531). A call names the message
-- it answers, so a retry on another API instance finds the call and asks the
-- model no second time (`callModelInConversation`). The key names the call's
-- own conversation (0099's key), so a call never points at another
-- conversation's message; a purge deletes the messages and the call keeps its
-- row without the pointer. A task call names no message.

alter table public.model_calls
  add column conversation_message_id uuid,
  add constraint model_calls_message_fkey
    foreign key (business_id, conversation_id, conversation_message_id)
    references public.conversation_messages (business_id, conversation_id, id)
    on delete set null (conversation_message_id),
  -- A key with a null column is not checked, so a task call is refused a message here.
  add constraint model_calls_message_is_a_conversations
    check (conversation_message_id is null or conversation_id is not null);

create unique index model_calls_one_per_message_idx
  on public.model_calls (business_id, conversation_message_id)
  where conversation_message_id is not null;
