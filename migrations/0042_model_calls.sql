-- SPDX-License-Identifier: AGPL-3.0-only
--
-- AW-01: the broker's record of every model call, and the copy register's
-- registration half.
--
-- `model_calls` is one row per priced call. It is written before anything is
-- sent: the row holds the operation's priced maximum out of the run's
-- reservation (`reserved_minor`), under the reservation's row lock, so the
-- calls a run makes can never together hold more than its reservation holds.
-- Accepted, started, completed and landed are four separate facts, each its
-- own column; a call reaches no higher than its operation declares. The
-- route, the credential kind and the account that carried it are recorded on
-- every call; a replay call records the kind `replay` and no account.
--
-- A call ends one of four ways:
--   settled            the answer was priced within the hold; the rest is released
--   released           positive proof nothing happened (or nothing was sent)
--   refused            refused before anything was sent, the reason recorded
--   liability_unknown  the provider may have acted and the cost is not known,
--                      or it came back above the hold: held at the maximum until
--                      a person records an outcome, never released by a machine
--
-- No prompt text and no answer text is stored here.
-- Numbered after main's 0041 at the rebase; the batch integration may number it again.

create table public.model_calls (
  business_id     uuid        not null,
  id              uuid        not null,
  run_id          uuid        not null,
  step_id         uuid        not null,
  lease_id        uuid        not null,
  version_id      uuid        not null,
  reservation_id  uuid        not null,
  delegation_id   uuid,
  operation_key   text        not null,
  route_key       text,
  route_reach     text,
  credential_kind text,
  account         text,
  state           text        not null,
  reserved_minor  bigint      not null,
  observed_minor  bigint,
  actual_minor    bigint,
  refusal_code    text,
  fault           text,
  drop_state      text,
  accepted_at     timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  landed_at       timestamptz,
  ended_at        timestamptz,
  constraint model_calls_pkey primary key (id),
  constraint model_calls_tenant_id_key unique (business_id, id),
  constraint model_calls_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint model_calls_run_fkey foreign key (business_id, run_id)
    references public.planned_runs (business_id, id),
  constraint model_calls_step_fkey foreign key (business_id, step_id)
    references public.planned_steps (business_id, id),
  constraint model_calls_lease_fkey foreign key (business_id, lease_id)
    references public.leases (business_id, id),
  constraint model_calls_version_fkey foreign key (business_id, version_id)
    references public.proposal_versions (business_id, id),
  constraint model_calls_reservation_fkey foreign key (business_id, reservation_id)
    references public.reservations (business_id, id),
  constraint model_calls_delegation_fkey foreign key (business_id, delegation_id)
    references public.delegations (business_id, id),
  constraint model_calls_state_known
    check (state in ('reserved', 'dispatched', 'settled', 'released', 'refused', 'liability_unknown')),
  constraint model_calls_route_known check (route_reach is null or route_reach in ('local', 'cloud')),
  constraint model_calls_credential_known
    check (credential_kind is null
           or credential_kind in ('subscription', 'api_key', 'cloud_credential', 'replay')),
  constraint model_calls_replay_has_no_account
    check (credential_kind is distinct from 'replay' or account is null),
  constraint model_calls_fault_known check (fault is null or fault in ('ours', 'provider')),
  constraint model_calls_drop_known
    check (drop_state is null or drop_state in ('dropped_worker_lost', 'dropped_no_answer')),
  constraint model_calls_drop_is_held check (drop_state is null or state = 'liability_unknown'),
  constraint model_calls_reserved_not_negative check (reserved_minor >= 0),
  constraint model_calls_hold_only_when_refused
    check ((reserved_minor = 0) = (state = 'refused')),
  constraint model_calls_refusal_has_code check ((state = 'refused') = (refusal_code is not null)),
  constraint model_calls_actual_within_hold
    check (actual_minor is null or (actual_minor >= 0 and actual_minor <= reserved_minor)),
  constraint model_calls_actual_only_when_settled check ((state = 'settled') = (actual_minor is not null)),
  constraint model_calls_observed_not_negative check (observed_minor is null or observed_minor >= 0),
  constraint model_calls_sent_has_route
    check (state in ('reserved', 'refused') or (route_key is not null and credential_kind is not null)),
  constraint model_calls_started_after_accepted check (started_at is null or started_at >= accepted_at),
  constraint model_calls_completed_after_started
    check (completed_at is null or (started_at is not null and completed_at >= started_at)),
  constraint model_calls_landed_after_completed
    check (landed_at is null or (completed_at is not null and landed_at >= completed_at)),
  constraint model_calls_ended_is_dated
    check ((state in ('reserved', 'dispatched', 'liability_unknown')) = (ended_at is null))
);

create index model_calls_business_idx on public.model_calls (business_id);

create index model_calls_reservation_idx on public.model_calls (business_id, reservation_id);

-- In flight is held or sent: a hold not yet sent counts toward every ceiling.
create index model_calls_in_flight_idx
  on public.model_calls (business_id, operation_key)
  where state in ('reserved', 'dispatched');

create index model_calls_route_in_flight_idx
  on public.model_calls (route_key)
  where state in ('reserved', 'dispatched');

alter table public.model_calls enable row level security;
alter table public.model_calls force row level security;

create policy tenancy_model_calls on public.model_calls
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_model_calls on public.model_calls
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.model_calls to ops_astro_app;


-- The copy register, registration half (AW-01; C84 in U94 adds retrieval and
-- erasure fan-out to this table and builds no second one). A copy of business
-- content made outside its own row (an outbound prompt, later a trace or a
-- checkpoint) is registered before it is first materialised, with its class,
-- its key, what invalidates it and how long it is kept. It is append only.

create table public.copy_registrations (
  business_id          uuid        not null,
  id                   uuid        not null,
  copy_class           text        not null,
  copy_key             text        not null,
  invalidation_trigger text        not null,
  retention_class      text        not null,
  registered_at        timestamptz not null default now(),
  constraint copy_registrations_pkey primary key (id),
  constraint copy_registrations_tenant_id_key unique (business_id, id),
  constraint copy_registrations_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint copy_registrations_class_known check (copy_class in ('outbound_prompt')),
  constraint copy_registrations_key_shape check (copy_key ~ '^[a-z_]+:[0-9a-f-]{36}$'),
  constraint copy_registrations_trigger_known
    check (invalidation_trigger in ('call_ended', 'run_ended', 'client_erased')),
  constraint copy_registrations_retention_known
    check (retention_class in ('transient', 'run', 'record'))
);

create unique index copy_registrations_key_idx
  on public.copy_registrations (business_id, copy_class, copy_key);

alter table public.copy_registrations enable row level security;
alter table public.copy_registrations force row level security;

create policy tenancy_copy_registrations on public.copy_registrations
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_copy_registrations on public.copy_registrations
  as permissive
  for all
  using (true)
  with check (true);

-- Invoker rights: raising needs no privilege, so no definer function is added.
create or replace function public.copy_registrations_append_only()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  raise exception 'copy_registrations is append only: registration % cannot be %',
    old.id, lower(tg_op);
end;
$$;

revoke all on function public.copy_registrations_append_only() from public;

create trigger copy_registrations_no_update
  before update or delete on public.copy_registrations
  for each row execute function public.copy_registrations_append_only();

grant select, insert on public.copy_registrations to ops_astro_app;


-- The fair share (AW-01; ORCH-DECISION SL11 AW-01). A provider route has one
-- ceiling for the whole installation, and a business with calls in flight on
-- it holds no more than its share: the ceiling divided by the businesses in
-- flight there, counting itself. A tenant transaction cannot count another
-- business's rows under row security, so the count is this one function,
-- which runs as its definer with row security off. It is the one read across
-- businesses and it is kept narrow on purpose:
--   * it answers one whole number, 1 when the calling business may hold one
--     more call on the route and 0 when it may not: no id, no business, no
--     count, and nothing larger than 1, which would say more about other
--     businesses' load than the decision needs;
--   * the business is the tenant transaction's own (app_business_id), never
--     an argument; with none set the answer is 0;
--   * PUBLIC may not execute it, and neither may the application's group:
--     only `ops_astro_broker`, a role that holds nothing else. The group may
--     take that role (SET) but does not inherit it, so the broker switches to
--     it for this one statement and back, and any other statement the
--     application sends is refused it.
-- The broker serialises the decision per route with an advisory lock before
-- it asks (packages/core-records/src/locks.ts). With an owner that does not
-- bypass row security the query is refused rather than answered from one
-- business's rows: `row_security = off` fails closed.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'ops_astro_broker') then
    create role ops_astro_broker nologin nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;

revoke all on schema ops from ops_astro_broker;
revoke all on all tables in schema public from ops_astro_broker;
revoke all on all tables in schema ops from ops_astro_broker;
revoke all on all functions in schema public from ops_astro_broker;

comment on role ops_astro_broker is
  'The credential broker''s role for the fair share''s one count across businesses. '
  'It executes public.model_route_room and holds nothing else; the application group '
  'may set it, never inherit it.';

grant ops_astro_broker to ops_astro_app with inherit false, set true;

create function public.model_route_room(route text, route_ceiling integer)
  returns integer
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  set row_security = off
as $$
  with here as (
    select public.app_business_id() as business_id
  ),
  flight as (
    select count(*)::integer as total,
           count(distinct c.business_id)::integer as holding,
           (count(*) filter (where c.business_id = (select business_id from here)))::integer as mine
      from public.model_calls c
     where c.route_key = route
       and c.state in ('reserved', 'dispatched')
  )
  select case
           when (select business_id from here) is null then 0
           when route_ceiling is null or route_ceiling < 1 then 0
           when f.total >= route_ceiling then 0
           when f.mine >= greatest(1, route_ceiling
                  / (f.holding + case when f.mine = 0 then 1 else 0 end)) then 0
           else 1
         end
    from flight f
$$;

revoke all on function public.model_route_room(text, integer) from public;
grant execute on function public.model_route_room(text, integer) to ops_astro_broker;
