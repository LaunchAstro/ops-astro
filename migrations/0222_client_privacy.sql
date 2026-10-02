-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0222 C60 (CS-7.40): a client's privacy settings, on the client record (0055),
-- and the history of its written requests for model use. The number is a
-- placeholder, renumbered when the batch lands.
--
-- Three settings, each off for a new client:
--
-- - `model_egress` and `model_providers`: whether this client's material may
--   go to a model, and to which providers. On only with a provider named, and
--   off with none. Switched on only by `client.set_privacy` with the client's
--   written request in the same transaction (owner line 51); every cloud
--   provider is refused while no local-model path exists (owner line 72).
-- - `handles_health`: the client handles health information, which keeps model
--   egress off (a check below). C62 and C15 read it for retention and exports.
-- - `no_agent_edits`: owner line O2; on, no edit run works on this client's
--   media (C77, C78).
--
-- Only those four columns may be updated, by the one command under
-- `privacy:manage`; the name stays written once.
--
-- A written request is kept whatever came of it: who asked, when, for which
-- providers, a link to the request itself, and the outcome (`applied`, or the
-- refusal's code). A request refused for a cloud provider is still recorded
-- (owner line 72). Written once; never updated or deleted.

alter table public.clients
  add column model_egress    boolean not null default false,
  add column model_providers text[]  not null default '{}',
  add column handles_health  boolean not null default false,
  add column no_agent_edits  boolean not null default false,
  add constraint clients_egress_names_providers check (
    model_egress = (cardinality(model_providers) > 0)
  ),
  add constraint clients_health_keeps_egress_off check (
    not (handles_health and model_egress)
  );

grant update (model_egress, model_providers, handles_health, no_agent_edits)
  on public.clients to ops_astro_app;

create table public.client_model_requests (
  business_id         uuid        not null,
  id                  uuid        not null,
  client_id           uuid        not null,
  requested_by        text        not null,
  requested_on        date        not null,
  request_link        text        not null,
  providers           text[]      not null,
  outcome             text        not null,
  recorded_at         timestamptz not null default now(),
  recorded_by_actor   uuid        not null,
  constraint client_model_requests_pkey primary key (id),
  constraint client_model_requests_tenant_id_key unique (business_id, id),
  constraint client_model_requests_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint client_model_requests_client_fkey foreign key (business_id, client_id)
    references public.clients (business_id, id),
  constraint client_model_requests_actor_fkey foreign key (business_id, recorded_by_actor)
    references public.actors (business_id, id),
  constraint client_model_requests_by_present check (
    length(btrim(requested_by)) between 1 and 200
  ),
  constraint client_model_requests_link_present check (
    length(btrim(request_link)) between 1 and 2000
  ),
  constraint client_model_requests_providers_named check (cardinality(providers) > 0),
  constraint client_model_requests_outcome_known check (
    outcome in ('applied', 'LOCAL_MODEL_REQUIRED', 'PROVIDER_NOT_ASSESSED',
                'CLIENT_HANDLES_HEALTH')
  )
);

create index client_model_requests_by_client
  on public.client_model_requests (business_id, client_id, recorded_at);

alter table public.client_model_requests enable row level security;
alter table public.client_model_requests force row level security;

create policy tenancy_client_model_requests on public.client_model_requests
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_client_model_requests on public.client_model_requests
  as permissive
  for all
  using (true)
  with check (true);

-- Written once: no update and no delete.
grant select, insert on public.client_model_requests to ops_astro_app;
