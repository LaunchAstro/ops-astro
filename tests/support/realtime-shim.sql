-- SPDX-License-Identifier: AGPL-3.0-only
--
-- A stand-in for the parts of Supabase Realtime the carriage migrations and
-- code touch, on plain Postgres. Applied to a test database before its
-- migrations, so the guarded statements (`to_regnamespace('realtime')`) run
-- as they run on a hosted project.
--
-- * `realtime.messages`, with row security on, as hosted: the policies the
--   migrations write land here, and `pg_policies` lists them.
-- * `realtime.topic()`, reading the topic the hub sets for one judgement.
-- * `realtime.send()` stores the message in `realtime.messages`, as hosted
--   stores a database broadcast, then notifies `realtime_shim` so the hub can
--   deliver it to joined subscribers.
-- * The `authenticated` role the policies name. It is the cluster's, so it is
--   made only where absent, and a twin made by another database at the same
--   moment is taken as made. It may log in, as an outsider holding nothing
--   outside a shimmed database, so the cluster's role census classes it.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated login;
  end if;
exception
  when duplicate_object or unique_violation then null;
end;
$$;

create schema realtime;

create table realtime.messages (
  id          uuid        not null default gen_random_uuid(),
  topic       text        not null,
  extension   text        not null,
  event       text,
  payload     jsonb,
  private     boolean     not null default false,
  inserted_at timestamptz not null default now(),
  primary key (id)
);

alter table realtime.messages enable row level security;

create function realtime.topic() returns text
  language sql
  stable
  as $$ select nullif(current_setting('realtime.topic', true), '') $$;

create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
  returns void
  language plpgsql
  as $$
begin
  insert into realtime.messages (topic, extension, event, payload, private)
  values (topic, 'broadcast', event, payload, private);
  perform pg_notify(
    'realtime_shim',
    jsonb_build_object('topic', topic, 'event', event, 'payload', payload)::text);
end;
$$;

grant usage on schema realtime to authenticated;
grant select, insert on realtime.messages to authenticated;
grant execute on function realtime.topic() to authenticated;
