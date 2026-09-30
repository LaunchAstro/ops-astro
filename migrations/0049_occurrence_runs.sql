-- SPDX-License-Identifier: AGPL-3.0-only
--
-- AW-01 J: an automation occurrence's run, the worker's system write (ORCH36
-- ruling, option B). Every run still has a task; an occurrence's run lands on
-- a new task accepted by the standing approval, and carries no plan lineage or
-- plan version, because the per-run gate a plan version opens is exactly what
-- a standing approval stands in for. Agent output on that task still takes its
-- own review round (AW-09), on the proposal it makes.
--
--   origin_occurrence_id         the occurrence that asked for the run. One run
--                                per occurrence, held here and not in code.
--                                Its foreign key to C33's occurrence record
--                                joins at the batch 3 join, with that table.
--   origin_definition_id         the definition, and
--   origin_approved_by_actor_id  the person whose standing approval carried
--                                it, named on the run as the audit event's
--                                digest names them. The version is the run's
--                                definition pin (0043).
--
-- A run is exactly one of a plan's run (lineage and version, no origin) or an
-- occurrence's run (an origin, no lineage or version).
--
-- Only the occurrence role writes an origin. `ops_astro_occurrence` holds
-- insert on runs, a read of a task's revision (for 0032's trigger) and the
-- tenancy policy's business, and nothing else; the application's group may take it for one statement (SET)
-- and never inherits it, as 0042 does for the broker. The trigger below
-- refuses an origin written by any other role, and any change to an origin
-- after the insert, so a run cannot be moved onto or off an occurrence.
--
-- Pickup works from a reservation on an approved plan version. A reservation
-- now names its run and its version together, so none can name an
-- occurrence's run (whose version is null) and pickup never reaches one until
-- AW-04 builds its claim.
-- Numbered after this stack's 0048; the batch 3 join numbers it again.

alter table public.planned_runs
  add column origin_occurrence_id uuid,
  add column origin_definition_id uuid,
  add column origin_approved_by_actor_id uuid,
  alter column lineage_id drop not null,
  alter column version_id drop not null;

alter table public.planned_runs
  add constraint planned_runs_one_origin check (
    (lineage_id is null) = (version_id is null)
    and (origin_occurrence_id is null) = (lineage_id is not null)
    and (origin_occurrence_id is null) = (origin_definition_id is null)
    and (origin_occurrence_id is null) = (origin_approved_by_actor_id is null)
  ),
  add constraint planned_runs_approver_fkey foreign key (business_id, origin_approved_by_actor_id)
    references public.actors (business_id, id);

create unique index planned_runs_occurrence_idx
  on public.planned_runs (business_id, origin_occurrence_id)
  where origin_occurrence_id is not null;

alter table public.reservations
  add constraint reservations_run_in_same_version
    foreign key (business_id, run_id, version_id)
    references public.planned_runs (business_id, id, version_id);

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'ops_astro_occurrence') then
    create role ops_astro_occurrence nologin nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;

revoke all on schema ops from ops_astro_occurrence;
revoke all on all tables in schema public from ops_astro_occurrence;
revoke all on all tables in schema ops from ops_astro_occurrence;
revoke all on all functions in schema public from ops_astro_occurrence;

grant insert on public.planned_runs to ops_astro_occurrence;
grant select (business_id, id, revision) on public.records to ops_astro_occurrence;
-- The tenancy policy on both tables reads the transaction's business.
grant execute on function public.app_business_id() to ops_astro_occurrence;

comment on role ops_astro_occurrence is
  'The worker''s role for an automation occurrence''s run (AW-01 J). It inserts runs and '
  'reads a task''s revision, and holds nothing else; the application group may set it for '
  'the one insert, never inherit it.';

grant ops_astro_occurrence to ops_astro_app with inherit false, set true;

create function public.planned_runs_occurrence_origin()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' then
    if (new.origin_occurrence_id, new.origin_definition_id, new.origin_approved_by_actor_id)
       is distinct from
       (old.origin_occurrence_id, old.origin_definition_id, old.origin_approved_by_actor_id) then
      raise exception 'OCCURRENCE_RUN_ROLE: a run''s origin is written once, at its insert'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.origin_occurrence_id is not null) <> (current_user = 'ops_astro_occurrence') then
    raise exception 'OCCURRENCE_RUN_ROLE: only the occurrence role writes an occurrence''s run, and it writes nothing else'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.planned_runs_occurrence_origin() from public;

create trigger planned_runs_occurrence_origin
  before insert or update on public.planned_runs
  for each row execute function public.planned_runs_occurrence_origin();
