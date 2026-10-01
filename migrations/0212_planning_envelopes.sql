-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0212 the planning budget (AW-04, U10). Every planning reply before the
-- accept is priced, and spends against a small budget of its own: the
-- business's planning cap (`budget_caps` key `planning`; none set means no
-- planning spend), with one planning envelope per conversation.
--
-- The envelope carries no totals. A planning call's hold is its own row, as a
-- task call's is (0191): committed is the sum of the calls' holds and settled
-- actuals, read under the cap's row lock, so two replies at once cannot both
-- take the last of it. The envelope names the conversation and the person who
-- owns it, so the planning spend beside the plan is that envelope's calls.
--
-- A conversation call (0202) was local and held nothing. A planning call is a
-- conversation call with an envelope: it holds its priced maximum, and its
-- route is the broker's choice under the data classes and AW-03's rule.
-- `conversation_id` has no foreign key, as 0202's has none: the conversations
-- table joins at the batch 3 join.

create table public.planning_envelopes (
  business_id     uuid        not null,
  id              uuid        not null,
  cap_id          uuid        not null,
  conversation_id uuid        not null,
  owner_person_id uuid        not null,
  opened_at       timestamptz not null default now(),
  constraint planning_envelopes_pkey primary key (id),
  constraint planning_envelopes_tenant_id_key unique (business_id, id),
  constraint planning_envelopes_one_per_conversation unique (business_id, conversation_id),
  constraint planning_envelopes_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint planning_envelopes_cap_fkey foreign key (business_id, cap_id)
    references public.budget_caps (business_id, id),
  constraint planning_envelopes_owner_fkey foreign key (business_id, owner_person_id)
    references public.people (business_id, id)
);

create index planning_envelopes_cap_idx on public.planning_envelopes (business_id, cap_id);

alter table public.planning_envelopes enable row level security;
alter table public.planning_envelopes force row level security;

create policy tenancy_planning_envelopes on public.planning_envelopes
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_planning_envelopes on public.planning_envelopes
  as permissive
  for all
  using (true)
  with check (true);

-- Insert and read only: an envelope is never moved to another cap or owner.
grant select, insert on public.planning_envelopes to ops_astro_app;

alter table public.model_calls add column planning_envelope_id uuid;

alter table public.model_calls
  add constraint model_calls_planning_envelope_fkey foreign key (business_id, planning_envelope_id)
    references public.planning_envelopes (business_id, id);

alter table public.model_calls drop constraint model_calls_one_scope;
alter table public.model_calls
  add constraint model_calls_one_scope check (
    (conversation_id is null and planning_envelope_id is null
      and run_id is not null and step_id is not null and lease_id is not null
      and version_id is not null and reservation_id is not null)
    or (conversation_id is not null
      and run_id is null and step_id is null and lease_id is null
      and version_id is null and reservation_id is null
      and delegation_id is null
      and (planning_envelope_id is not null
           or (route_reach = 'local' and reserved_minor = 0))));

create index model_calls_planning_envelope_idx
  on public.model_calls (business_id, planning_envelope_id)
  where planning_envelope_id is not null;
