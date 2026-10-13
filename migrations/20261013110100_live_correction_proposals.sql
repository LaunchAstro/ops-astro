-- SPDX-License-Identifier: AGPL-3.0-only
--
-- C80: a live correction's proposal (its branch, its one commit and the
-- request opened from it), one row per correction, claimed under the
-- correction's live worker lease before the first provider send: the seam
-- branch, the commit it starts at and the site file's blob there. A second
-- claim (another job, or a restart) finds the row, sends nothing and reconciles
-- by the seam. The row is settled once, `proposed` with its head commit and
-- request number or `unknown` for a person, and neither moves again. Only a
-- `proposed` row feeds the publish's binding.

create table public.live_correction_proposals (
  business_id     uuid        not null,
  correction_id   uuid        not null,
  seam_branch     text        not null,
  base_revision   text        not null,
  pre_image_blob  text        not null,
  head_commit     text,
  request_number  text,
  state           text        not null default 'claimed',
  lease_id        uuid        not null,
  fence           bigint      not null,
  claimed_at      timestamptz not null default clock_timestamp(),
  settled_at      timestamptz,
  constraint live_correction_proposals_pkey primary key (business_id, correction_id),
  constraint live_correction_proposals_correction_fkey foreign key (business_id, correction_id)
    references public.live_corrections (business_id, id),
  constraint live_correction_proposals_lease_fkey foreign key (business_id, lease_id)
    references public.leases (business_id, id),
  constraint live_correction_proposals_state_known
    check (state in ('claimed', 'proposed', 'unknown')),
  constraint live_correction_proposals_proposed_whole
    check ((state = 'proposed') = (head_commit is not null and request_number is not null)),
  constraint live_correction_proposals_settled_when
    check ((state = 'claimed') = (settled_at is null)),
  constraint live_correction_proposals_present
    check (seam_branch <> '' and base_revision <> '' and pre_image_blob <> '')
);

alter table public.live_correction_proposals enable row level security;
alter table public.live_correction_proposals force row level security;

create policy tenancy_live_correction_proposals on public.live_correction_proposals
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_live_correction_proposals on public.live_correction_proposals
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.live_correction_proposals to ops_astro_app;
grant update (state, head_commit, request_number, settled_at)
  on public.live_correction_proposals to ops_astro_app;

-- A settled proposal keeps its answer: only a claimed row moves. Invoker, not
-- definer: raising needs no privilege.
create or replace function public.live_correction_proposals_settled_once()
  returns trigger
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
begin
  if old.state <> 'claimed'
     and (new.state, new.head_commit, new.request_number, new.settled_at)
         is distinct from (old.state, old.head_commit, old.request_number, old.settled_at) then
    raise exception 'live_correction_proposals_settled_once: a settled proposal does not move'
      using errcode = 'P0001', constraint = 'live_correction_proposals_settled_once';
  end if;
  return new;
end;
$$;

revoke all on function public.live_correction_proposals_settled_once() from public;

create trigger live_correction_proposals_settled_once
  before update on public.live_correction_proposals
  for each row execute function public.live_correction_proposals_settled_once();
