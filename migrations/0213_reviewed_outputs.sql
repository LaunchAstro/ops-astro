-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0213 the reviewed output (AW-08). Accepting the plan lets the agent work; it
-- never releases an effect. The agent hands its output back with a successor
-- version, and that successor is the reviewed output: the one version whose
-- accept, the launch, lets its effect be dispatched.
--
-- One row per reviewed output, written by the handback in the transaction that
-- writes the successor, naming the lease whose work produced it. Dispatch
-- reads it under its locks and refuses a version without one. A version with
-- no row was approved as a plan (or proposed by hand), and its approval lets
-- work run but fires nothing.
--
-- The row is a fact about how the version came to be, so it is never
-- rewritten: the application inserts and reads it, and may never update or
-- delete one. The trigger checks the row's own subject, not just its pointers:
-- the version and the lease's run are on the lineage the row names, so a
-- handback cannot mark a version of another lineage.

create table public.reviewed_outputs (
  business_id uuid        not null,
  version_id  uuid        not null,
  lineage_id  uuid        not null,
  lease_id    uuid        not null,
  marked_at   timestamptz not null default now(),
  constraint reviewed_outputs_pkey primary key (business_id, version_id),
  constraint reviewed_outputs_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint reviewed_outputs_version_fkey foreign key (business_id, version_id)
    references public.proposal_versions (business_id, id),
  constraint reviewed_outputs_lineage_fkey foreign key (business_id, lineage_id)
    references public.proposal_lineages (business_id, id),
  constraint reviewed_outputs_lease_fkey foreign key (business_id, lease_id)
    references public.leases (business_id, id)
);

create index reviewed_outputs_lease_idx on public.reviewed_outputs (business_id, lease_id);

create function public.reviewed_outputs_on_their_lineage() returns trigger
  language plpgsql
  as $$
begin
  if not exists (select 1 from public.proposal_versions v
                  where v.business_id = new.business_id and v.id = new.version_id
                    and v.lineage_id = new.lineage_id)
     or not exists (select 1 from public.leases l
                      join public.planned_runs r on r.business_id = l.business_id and r.id = l.run_id
                     where l.business_id = new.business_id and l.id = new.lease_id
                       and r.lineage_id = new.lineage_id) then
    raise exception 'reviewed_outputs: the version and the lease''s work are on the named lineage'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.reviewed_outputs_on_their_lineage() from public;

create trigger reviewed_outputs_on_their_lineage
  before insert on public.reviewed_outputs
  for each row execute function public.reviewed_outputs_on_their_lineage();

alter table public.reviewed_outputs enable row level security;
alter table public.reviewed_outputs force row level security;

create policy tenancy_reviewed_outputs on public.reviewed_outputs
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_reviewed_outputs on public.reviewed_outputs
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.reviewed_outputs to ops_astro_app;
