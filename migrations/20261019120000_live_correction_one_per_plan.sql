-- SPDX-License-Identifier: AGPL-3.0-only
--
-- #1717 (#1624 R8a): one agent-drafted correction per accepted plan version
-- (owner ruling Q2). An agent asks under the delegation its pickup minted, and
-- that pickup's lease serves one reservation, which serves one plan version
-- (`reservations_version_idx`). The door stores that version with the request,
-- read on the server from the lease, never taken from a caller. A second
-- attempt on the same plan, or two at once, is answered the first correction:
-- the unique index is the lock two requests meet, and the second's insert
-- waits on it and stores nothing. A person's request carries no plan version
-- and is not limited here.

alter table public.live_corrections
  add column plan_version_id uuid,
  add constraint live_corrections_plan_version_fkey foreign key (business_id, plan_version_id)
    references public.proposal_versions (business_id, id);

create unique index live_corrections_one_per_plan_idx
  on public.live_corrections (business_id, plan_version_id)
  where plan_version_id is not null;

-- The plan a correction was drafted for never changes once stored.
create or replace function public.live_corrections_plan_kept()
  returns trigger
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
begin
  if new.plan_version_id is distinct from old.plan_version_id then
    raise exception 'live_corrections_plan_kept: correction % keeps its plan', old.id;
  end if;
  return new;
end;
$$;

revoke all on function public.live_corrections_plan_kept() from public;

create trigger live_corrections_plan_kept
  before update on public.live_corrections
  for each row execute function public.live_corrections_plan_kept();
