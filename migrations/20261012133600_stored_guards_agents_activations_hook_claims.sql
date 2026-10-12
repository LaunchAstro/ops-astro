-- SPDX-License-Identifier: AGPL-3.0-only
-- A UTC timestamp ID (docs/local/DATA.md, "What the schema is").
--
-- 20261012133600 three rows the application role wrote with no database rule
-- behind the product's own (package P03). Each guard holds a new write; no
-- stored row is read or rewritten.
--
-- An agent credential is held by an agent. 0054 checked `agent_actor_id` only
-- as an actor of the business, so a person actor, the issuer's own included,
-- could be stored as the agent the credential speaks for. A before-insert
-- trigger now asks that the agent is an actor of kind agent and the issuer the
-- person actor of `issued_by_person_id`, as 0008 asks of a delegation. An
-- after trigger, as `activations_mode_permitted` is, so row security refuses
-- another business's row first. Both actor rows are read `for share`, so an
-- update to either waits for this insert to commit. Insert only: 0054's
-- `agent_credentials_written_once` already fixes both columns.
--
-- An activation's change moves its revision one step, at the database's
-- clock. 20261005003850 granted the application role `revision` and
-- `changed_at`, so a direct statement could roll the revision back to one a
-- standing approval already names (20261005193201), skip ahead, keep it, or
-- back-date the change. Every product update writes `revision + 1` and
-- `now()`; a before-update trigger refuses anything else.
--
-- A Send Email hook message's claim (20261005190651) only matters while the
-- message could be replayed, and the hook's signature check refuses a message
-- more than five minutes from its timestamp (`EMAIL_HOOK_TOLERANCE_S`,
-- core-connectors/src/email-hook.ts). The claim now records when it was made,
-- the daily upkeep job (`backup.mjs expire`) removes claims older than a day
-- through `ops.expire_auth_hook_messages()` as `ops_astro_upkeep` (as
-- 20261002105957 does for second-factor codes), and the application group
-- reads and claims by the digest column alone, so it cannot set a claim's
-- time and a later column is not granted with the table.

create function public.agent_credentials_held_by_an_agent() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
  as $$
begin
  if not exists (
    select 1 from public.actors a
     where a.business_id = new.business_id and a.id = new.agent_actor_id and a.kind = 'agent'
       for share
  ) then
    raise exception 'agent_credentials: agent_actor_id % is not an actor of kind agent',
      new.agent_actor_id
      using errcode = 'check_violation', constraint = 'agent_credentials_held_by_an_agent';
  end if;
  if not exists (
    select 1 from public.actors a
     where a.business_id = new.business_id and a.id = new.issued_by_actor_id
       and a.kind = 'person' and a.person_id = new.issued_by_person_id
       for share
  ) then
    raise exception 'agent_credentials: issued_by_actor_id % is not the issuing person''s actor',
      new.issued_by_actor_id
      using errcode = 'check_violation', constraint = 'agent_credentials_held_by_an_agent';
  end if;
  return new;
end;
$$;

revoke execute on function public.agent_credentials_held_by_an_agent() from public;

create constraint trigger agent_credentials_held_by_an_agent
  after insert on public.agent_credentials
  for each row execute function public.agent_credentials_held_by_an_agent();

create function public.activations_change_one_step() returns trigger
  language plpgsql
  set search_path = pg_catalog
  as $$
begin
  if new.revision is distinct from old.revision + 1 or new.changed_at is distinct from now() then
    raise exception 'activations: a change of revision % writes revision % at now(), not % at %',
      old.revision, old.revision + 1, new.revision, new.changed_at
      using errcode = 'check_violation', constraint = 'activations_change_one_step';
  end if;
  return new;
end;
$$;

revoke execute on function public.activations_change_one_step() from public;

create trigger activations_change_one_step
  before update on public.activations
  for each row execute function public.activations_change_one_step();

alter table ops.auth_hook_messages add column claimed_at timestamptz not null default now();

revoke select, insert on ops.auth_hook_messages from ops_astro_app;
grant select (message_digest), insert (message_digest) on ops.auth_hook_messages to ops_astro_app;

create function ops.expire_auth_hook_messages() returns bigint
  language sql security definer set search_path = pg_catalog as $$
  with gone as (
    delete from ops.auth_hook_messages where claimed_at < now() - interval '24 hours'
    returning 1
  )
  select count(*) from gone
$$;
revoke execute on function ops.expire_auth_hook_messages() from public;
grant execute on function ops.expire_auth_hook_messages() to ops_astro_upkeep;

comment on role ops_astro_upkeep is
  'Daily upkeep identity. Runs ops.expire_second_factor_codes() and '
  'ops.expire_auth_hook_messages() alone; no read, no other write, no login of its own.';
