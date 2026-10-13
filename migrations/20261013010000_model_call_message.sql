-- SPDX-License-Identifier: AGPL-3.0-only
--
-- One model call per conversation message (#1531). A call names the message
-- it answers, so a retry on another API instance finds the call and asks the
-- model no second time (`callModelInConversation`); the unique index is what
-- holds it. The broker names only the message the exchange read as the
-- caller's own, in that conversation. There is no foreign key to the message:
-- one would make every lock on a message a lock on its call, and a purge
-- deleting the messages would fault a call in flight instead of keeping
-- nothing. A task call names no message.

alter table public.model_calls
  add column conversation_message_id uuid,
  add constraint model_calls_message_is_a_conversations
    check (conversation_message_id is null or conversation_id is not null);

create unique index model_calls_one_per_message_idx
  on public.model_calls (business_id, conversation_message_id)
  where conversation_message_id is not null;
