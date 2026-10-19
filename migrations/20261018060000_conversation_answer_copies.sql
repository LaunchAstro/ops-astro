-- SPDX-License-Identifier: AGPL-3.0-only
--
-- #1563: a conversation call's answer, copied at its settlement.
--
-- A message has one model call (#1531). Its reply is kept after the call
-- settles, in a transaction of its own, so a keep that rolls back or dies
-- would leave the message with a settled call and no reply, and asking the
-- model again would charge twice. The settlement keeps the answer here, in
-- its own transaction, and a retry keeps the reply from this copy under the
-- conversation's row lock, never asking the model again.
--
-- The copy is transient. The keep that turns it into the reply deletes it in
-- the same transaction, and the purge deletes it with the conversation's
-- body. The settlement holds the conversation's row for its key, after the
-- call's row as custody takes them, and copies only into a body not purged:
-- a purge waits for a copy being made and deletes it, or the copy is not
-- made. There is no foreign key to the message: a lock on a message would
-- then hold up its call's settlement (20261013010000).

create table public.conversation_answer_copies (
  business_id     uuid        not null,
  call_id         uuid        not null,
  conversation_id uuid        not null,
  message_id      uuid        not null,
  body            text        not null,
  copied_at       timestamptz not null default now(),
  constraint conversation_answer_copies_pkey primary key (business_id, call_id),
  constraint conversation_answer_copies_message_key unique (business_id, message_id),
  constraint conversation_answer_copies_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint conversation_answer_copies_call_fkey foreign key (business_id, call_id)
    references public.model_calls (business_id, id),
  constraint conversation_answer_copies_conversation_fkey foreign key (business_id, conversation_id)
    references public.conversations (business_id, id),
  constraint conversation_answer_copies_body_bounded check (char_length(body) between 1 and 20000)
);

alter table public.conversation_answer_copies enable row level security;
alter table public.conversation_answer_copies force row level security;

create policy tenancy_conversation_answer_copies on public.conversation_answer_copies
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_conversation_answer_copies on public.conversation_answer_copies
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, delete on public.conversation_answer_copies to ops_astro_app;

-- The copy register (0085) names the class before the first copy is written:
-- invalidated when its reply is kept, and transient.
alter table public.copy_registrations drop constraint copy_registrations_class_known;
alter table public.copy_registrations add constraint copy_registrations_class_known
  check (copy_class in ('outbound_prompt', 'diagnostic_trace', 'answer_copy'));
alter table public.copy_registrations drop constraint copy_registrations_trigger_known;
alter table public.copy_registrations add constraint copy_registrations_trigger_known
  check (invalidation_trigger in ('call_ended', 'run_ended', 'client_erased', 'reply_kept'));
