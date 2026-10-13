-- SPDX-License-Identifier: AGPL-3.0-only
--
-- A conversation call carried to the model agent on the owner's machine
-- (#1531, live chat route B), and the doorbell that tells the agent of it.
--
-- One row per carried call, written with the call in the same transaction,
-- naming the agent that is to carry it. It holds ids and times, never a word
-- of the conversation. Its times are set once each, in order:
--   offered_at   the offer, after the judgement passed; the doorbell rings
--   runner       the agent process the request went to, with
--   request_at   when the send was decided (only then is the request sent),
--   send_by      the agent's accept-anchored write deadline, and
--   answer_by    the latest instant an answer may settle the call.
-- The lost-call sweep reads `request_at`: null proves nothing was sent.
--
-- The doorbell is rung by the database in the transaction that sets
-- `offered_at`, so it rings exactly when the offer commits. It carries the
-- conversation and the call by id, on the agent's own topic, and nothing
-- else (`ops_carry_ring`). Where Realtime is not installed (the test
-- database, a server with no Supabase) the ring does nothing.

create table public.model_call_carriers (
  business_id    uuid        not null,
  call_id        uuid        not null,
  agent_actor_id uuid        not null,
  offered_at     timestamptz,
  runner         uuid,
  request_at     timestamptz,
  send_by        timestamptz,
  answer_by      timestamptz,
  constraint model_call_carriers_pkey primary key (business_id, call_id),
  constraint model_call_carriers_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint model_call_carriers_call_fkey foreign key (business_id, call_id)
    references public.model_calls (business_id, id),
  constraint model_call_carriers_agent_fkey foreign key (business_id, agent_actor_id)
    references public.actors (business_id, id),
  -- The send's four facts are decided together.
  constraint model_call_carriers_send_together check (
    (runner is null) = (request_at is null)
    and (runner is null) = (send_by is null)
    and (runner is null) = (answer_by is null)),
  constraint model_call_carriers_send_after_offer
    check (request_at is null or (offered_at is not null and request_at >= offered_at)),
  constraint model_call_carriers_answer_after_send
    check (answer_by is null or answer_by > request_at)
);

create index model_call_carriers_agent_idx
  on public.model_call_carriers (business_id, agent_actor_id);

-- A carried call is a conversation call still with the model when its row is written.
create function public.model_call_carriers_carry_a_conversation_call() returns trigger
  language plpgsql
  as $$
begin
  if new.offered_at is not null or new.runner is not null or not exists (
    select 1 from public.model_calls c
     where c.business_id = new.business_id and c.id = new.call_id
       and c.conversation_id is not null and c.state = 'dispatched'
  ) then
    raise exception 'model_call_carriers: % is not a dispatched conversation call, unoffered',
      new.call_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.model_call_carriers_carry_a_conversation_call() from public;

create trigger model_call_carriers_carry_a_conversation_call
  before insert on public.model_call_carriers
  for each row execute function public.model_call_carriers_carry_a_conversation_call();

-- Each time is set once: a set value never changes or clears, and the row's
-- names never change.
create function public.model_call_carriers_set_once() returns trigger
  language plpgsql
  as $$
begin
  if (new.business_id, new.call_id, new.agent_actor_id)
       is distinct from (old.business_id, old.call_id, old.agent_actor_id)
     or old.offered_at is not null and new.offered_at is distinct from old.offered_at
     or old.runner is not null
       and (new.runner, new.request_at, new.send_by, new.answer_by)
         is distinct from (old.runner, old.request_at, old.send_by, old.answer_by)
  then
    raise exception 'model_call_carriers: % is set once', new.call_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.model_call_carriers_set_once() from public;

create trigger model_call_carriers_set_once
  before update on public.model_call_carriers
  for each row execute function public.model_call_carriers_set_once();

-- The doorbell: ids only, on the agent's own topic, as a private database
-- broadcast. Owned by the migration role and executable by nobody else; the
-- trigger below is its one caller.
create function public.ops_carry_ring(business uuid, agent uuid, conversation uuid, call uuid)
  returns void
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  as $$
begin
  if to_regnamespace('realtime') is null then
    return;
  end if;
  execute 'select realtime.send($1, $2, $3, true)'
    using jsonb_build_object('c', conversation, 'k', call),
          'offer',
          format('carry:%s:agent:%s', business, agent);
end;
$$;

revoke all on function public.ops_carry_ring(uuid, uuid, uuid, uuid) from public;

create function public.model_call_carriers_ring() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  set row_security = off
  as $$
begin
  perform public.ops_carry_ring(new.business_id, new.agent_actor_id, c.conversation_id, new.call_id)
     from public.model_calls c
    where c.business_id = new.business_id and c.id = new.call_id;
  return null;
end;
$$;

revoke execute on function public.model_call_carriers_ring() from public;

create trigger model_call_carriers_ring
  after update of offered_at on public.model_call_carriers
  for each row
  when (old.offered_at is null and new.offered_at is not null)
  execute function public.model_call_carriers_ring();

alter table public.model_call_carriers enable row level security;
alter table public.model_call_carriers force row level security;

create policy tenancy_model_call_carriers on public.model_call_carriers
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_model_call_carriers on public.model_call_carriers
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.model_call_carriers to ops_astro_app;
grant update (offered_at, runner, request_at, send_by, answer_by)
  on public.model_call_carriers to ops_astro_app;
