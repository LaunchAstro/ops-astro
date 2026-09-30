-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0049 connections: the connector fleet and its repairs (MP-14-7a, U33).
--
-- One `connections` row per connector the business runs: which source, its
-- status and the class of its last failure, how often it should sync and
-- when it last did, the scope it was authorised with, and a reference to the
-- credential it uses in custody (0048). A reference only: the row holds the
-- secret's id, never any part of a value, and the fleet read shows whether
-- that secret is set and nothing more.
--
-- `failure_class` is a short class from a fixed list, never a provider's
-- message or body: a provider's error can quote a token or a client's data
-- back, and this column is drawn on a screen every member can open.
--
-- `connection_clients` says which clients a connection serves, as the
-- connection record knows them. The fleet read filters on it, so a holder
-- whose `connection:read` is scoped to one client sees the connections that
-- serve that client, and that client alone in each one's list.
--
-- Rows are written by the connector's own setup (MP-13-5, `connection:write`)
-- and the broker's sync (AW-01), neither built yet. This migration grants the
-- application role select only on both tables: nothing here writes them.
--
-- `connection_repairs` records `connector repair started` (CS-14.12): who
-- started a repair of which connection, at which revision. One repair per
-- connection revision, so starting it twice on the same version is the same
-- repair. Starting one sends nothing anywhere: re-authorising is the
-- broker's (AW-01) and passes the approval gate on this exact version first.

create table public.connections (
  business_id        uuid        not null,
  id                 uuid        not null,
  connector_key      text        not null,
  label              text        not null,
  auth_method        text        not null default '',
  status             text        not null,
  failure_class      text,
  cadence_minutes    integer     not null default 1440,
  last_synced_at     timestamptz,
  last_attempt_at    timestamptz,
  scope              text        not null default '',
  read_components    text[]      not null default '{}',
  execute_components text[]      not null default '{}',
  secret_id          uuid,
  revision           bigint      not null default 1,
  created_at         timestamptz not null default now(),
  constraint connections_pkey primary key (id),
  constraint connections_tenant_id_key unique (business_id, id),
  constraint connections_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint connections_secret_fkey foreign key (business_id, secret_id)
    references public.custody_secrets (business_id, id),
  constraint connections_connector_key_shape check (connector_key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  constraint connections_label_length check (char_length(label) between 1 and 200),
  constraint connections_status_known check (status in ('active', 'degraded', 'broken')),
  constraint connections_failure_class_known check (failure_class in (
    'auth_expired', 'auth_revoked', 'quota_exhausted', 'throttled', 'unreachable',
    'schema_changed')),
  -- An active connection has no failure; a degraded or broken one names its class.
  constraint connections_failure_matches_status check ((status = 'active') = (failure_class is null)),
  constraint connections_cadence_positive check (cadence_minutes > 0),
  constraint connections_revision_positive check (revision >= 1)
);

create table public.connection_clients (
  business_id   uuid not null,
  connection_id uuid not null,
  client_id     uuid not null,
  client_label  text not null,
  constraint connection_clients_pkey primary key (business_id, connection_id, client_id),
  constraint connection_clients_connection_fkey foreign key (business_id, connection_id)
    references public.connections (business_id, id),
  constraint connection_clients_label_length check (char_length(client_label) between 1 and 200)
);

create index connection_clients_client_idx
  on public.connection_clients (business_id, client_id);

create table public.connection_repairs (
  business_id         uuid        not null,
  id                  uuid        not null,
  connection_id       uuid        not null,
  connection_revision bigint      not null,
  started_by_actor_id uuid        not null,
  started_at          timestamptz not null default now(),
  constraint connection_repairs_pkey primary key (id),
  constraint connection_repairs_tenant_id_key unique (business_id, id),
  constraint connection_repairs_connection_fkey foreign key (business_id, connection_id)
    references public.connections (business_id, id),
  constraint connection_repairs_started_by_fkey foreign key (business_id, started_by_actor_id)
    references public.actors (business_id, id),
  constraint connection_repairs_one_per_revision unique (business_id, connection_id, connection_revision)
);

alter table public.connections enable row level security;
alter table public.connections force row level security;
alter table public.connection_clients enable row level security;
alter table public.connection_clients force row level security;
alter table public.connection_repairs enable row level security;
alter table public.connection_repairs force row level security;

create policy tenancy_connections on public.connections
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_connections on public.connections
  as permissive for all using (true) with check (true);

create policy tenancy_connection_clients on public.connection_clients
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_connection_clients on public.connection_clients
  as permissive for all using (true) with check (true);

create policy tenancy_connection_repairs on public.connection_repairs
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_connection_repairs on public.connection_repairs
  as permissive for all using (true) with check (true);

grant select on public.connections to ops_astro_app;
grant select on public.connection_clients to ops_astro_app;
grant select, insert on public.connection_repairs to ops_astro_app;
