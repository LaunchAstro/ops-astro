-- SPDX-License-Identifier: AGPL-3.0-only
--
-- A conversation call carried to the model agent on the owner's machine
-- (#1531, live chat route B). One row per carried call, written with the call,
-- naming the agent. Ids and times only, never a word of the conversation, each
-- time set once and in order: `offered_at` (the offer; the doorbell rings),
-- then together `runner` (the agent process sent to), `request_at` (the send
-- decided; only then is the request sent), `send_by` (the write deadline) and
-- `answer_by` (the latest an answer may settle). The sweep reads `request_at`:
-- null proves nothing was sent.
--
-- The doorbell is rung by the database in the transaction that sets
-- `offered_at`, with the conversation and call ids, on the agent's own topic
-- (`ops_carry_ring`). Where Realtime is not installed it does nothing.

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
  constraint model_call_carriers_call_fkey foreign key (business_id, call_id)
    references public.model_calls (business_id, id),
  constraint model_call_carriers_agent_fkey foreign key (business_id, agent_actor_id)
    references public.actors (business_id, id),
  constraint model_call_carriers_send_together check (
    (runner is null) = (request_at is null) and (runner is null) = (send_by is null)
    and (runner is null) = (answer_by is null)),
  constraint model_call_carriers_send_after_offer
    check (request_at is null or (offered_at is not null and request_at >= offered_at)),
  constraint model_call_carriers_answer_after_send check (answer_by is null or answer_by > request_at)
);

-- Written unset, for a dispatched conversation call; afterwards each time is set once.
create function public.model_call_carriers_guard() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'INSERT' and (new.offered_at is not null or new.runner is not null or not exists (
       select 1 from public.model_calls c
        where c.business_id = new.business_id and c.id = new.call_id
          and c.conversation_id is not null and c.state = 'dispatched'))
     or tg_op = 'UPDATE' and (
       (new.business_id, new.call_id, new.agent_actor_id)
         is distinct from (old.business_id, old.call_id, old.agent_actor_id)
       or old.offered_at is not null and new.offered_at is distinct from old.offered_at
       or old.runner is not null and (new.runner, new.request_at, new.send_by, new.answer_by)
         is distinct from (old.runner, old.request_at, old.send_by, old.answer_by)) then
    raise exception 'model_call_carriers: written unset for a dispatched conversation call, set once'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.model_call_carriers_guard() from public;

create trigger model_call_carriers_guard
  before insert or update on public.model_call_carriers
  for each row execute function public.model_call_carriers_guard();

-- The doorbell: ids only, a private database broadcast on the agent's topic.
-- Owned by the migration role and executable by nobody else.
create function public.ops_carry_ring(business uuid, agent uuid, conversation uuid, call uuid)
  returns void
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  as $$
begin
  if to_regnamespace('realtime') is not null then
    execute 'select realtime.send($1, $2, $3, true)'
      using jsonb_build_object('c', conversation, 'k', call), 'offer',
            format('carry:%s:agent:%s', business, agent);
  end if;
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
  for each row when (old.offered_at is null and new.offered_at is not null)
  execute function public.model_call_carriers_ring();

alter table public.model_call_carriers enable row level security;
alter table public.model_call_carriers force row level security;

create policy tenancy_model_call_carriers on public.model_call_carriers
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_model_call_carriers on public.model_call_carriers
  as permissive for all using (true) with check (true);

grant select, insert on public.model_call_carriers to ops_astro_app;
grant update (offered_at, runner, request_at, send_by, answer_by)
  on public.model_call_carriers to ops_astro_app;
