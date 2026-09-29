-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0036 a terminal lineage stays terminal (T3a).
--
-- 0010 keeps a lineage's state, reason and time consistent with each other
-- and says nothing about when they may change. A rejected, cancelled or
-- completed lineage is closed by a person's decision or the classifier, and
-- `decide`, `propose` and `task.cancel` each refuse to act on one
-- (`LINEAGE_TERMINAL`); this is the barrier under them, for every role. Once
-- terminal, the row is neither updated nor deleted, and no new version is
-- written into it. An authorised restart opens a new lineage and never
-- reopens this one. Supersession stays in the command layer (RN-12): nothing
-- here touches the gate tables.

create or replace function public.proposal_lineages_terminal_is_final()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if old.state <> 'live' then
    raise exception 'LINEAGE_TERMINAL: lineage % is %, and a terminal lineage cannot be %',
      old.id, old.state, lower(tg_op)
      using errcode = 'check_violation';
  end if;
  return case tg_op when 'DELETE' then old else new end;
end;
$$;

revoke all on function public.proposal_lineages_terminal_is_final() from public;

create trigger proposal_lineages_terminal_is_final
  before update or delete on public.proposal_lineages
  for each row execute function public.proposal_lineages_terminal_is_final();

create or replace function public.proposal_versions_on_live_lineage()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  lineage_state text;
begin
  -- Read as the caller, so another business's lineage is invisible here. A
  -- lineage this caller cannot see is left to the tenancy check and the
  -- foreign key, which answer it as they always have; only a visible terminal
  -- lineage is refused here.
  --
  -- The lock is the lineage row, for share, and the read runs after the row
  -- is written (an AFTER trigger, so after every BEFORE trigger too). A
  -- terminal transition that committed first is seen here; one that comes
  -- second waits on this lock for the insert to commit, so a version and a
  -- cancel never cross (Sol review 1 on #153, criterion 2).
  select state into lineage_state from public.proposal_lineages
   where business_id = new.business_id and id = new.lineage_id
     for share;
  if lineage_state is not null and lineage_state <> 'live' then
    raise exception 'LINEAGE_TERMINAL: lineage % is %, and takes no further versions',
      new.lineage_id, lineage_state
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

revoke all on function public.proposal_versions_on_live_lineage() from public;

create trigger proposal_versions_on_live_lineage
  after insert on public.proposal_versions
  for each row execute function public.proposal_versions_on_live_lineage();
