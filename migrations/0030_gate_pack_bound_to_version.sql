-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0030 a gate's evidence pack is its version's, and a decided gate keeps its
-- version.
--
-- 0021 bound a gate's run, step and lineage to its version, but not its pack:
-- `gates_evidence_fkey` (0011) names the pack by business and id only. The
-- application role, with no owner access, could point a decided gate at
-- another version's pack, or add a superseded version with its own run, step
-- and pack to the lineage and move the decided gate onto it. Everything 0021
-- checks then agrees, and the decision's signed digest no longer describes
-- the version the gate names. The proposal read notices and answers
-- DECISION_INTEGRITY (R2-THERMO-17); storage now refuses the write as well
-- (FR2-RUNTIME, "Found on the way"; Nathan approved as FR2-P2).
--
-- Two rules, the same argument as 0021 one column further on:
--
--   1. The gate's pack is a pack of the gate's version: a composite foreign
--      key onto a unique key of `evidence_packs`. 0010 already allows one pack
--      per version, so the pack a gate may name is exactly its version's.
--   2. Once a gate is decided it keeps its version. A version change is
--      refused while a decision names the gate, or once the gate has left
--      `pending`, which is what a decision does to it and what supersession
--      does to it. No code path changes `gates.version_id` at all (`decide.ts`
--      and `proposal-writer.ts` write only `state` and `decided_at`), so this
--      stops only a writer that skips them. With the version fixed, rule 1
--      and 0021 fix the pack, run, step and lineage with it.
--
-- Additive. It rewrites and deletes nothing, and grants are unchanged
-- (0011's select, insert and update on `gates`, 0010's select and insert on
-- `evidence_packs`). A constraint does not judge rows already written, so both
-- rules are checked here once against them first: a database already holding
-- a gate whose pack is another version's, or a decided gate whose version is
-- not the one its decision names, fails this migration with the gate named
-- and stays at 0029 with its rows untouched. The check returns no rows on any
-- database the runtime has written.

do $$
declare
  bad record;
begin
  select g.business_id, g.id, g.version_id, g.evidence_pack_id
    into bad
    from public.gates g
    left join public.evidence_packs p
      on p.business_id = g.business_id and p.id = g.evidence_pack_id
     and p.version_id = g.version_id
   where p.id is null
   limit 1;
  if found then
    raise exception 'gates: gate % in business % names evidence pack %, which is not a pack of its version %',
      bad.id, bad.business_id, bad.evidence_pack_id, bad.version_id
      using errcode = 'foreign_key_violation', constraint = 'gates_pack_in_same_version';
  end if;
  select g.business_id, g.id, g.version_id, d.version_id as decided_version
    into bad
    from public.gates g
    join public.gate_decisions d on d.business_id = g.business_id and d.gate_id = g.id
   where d.version_id <> g.version_id
   limit 1;
  if found then
    raise exception 'gates: decided gate % in business % names version %, but its decision is on version %',
      bad.id, bad.business_id, bad.version_id, bad.decided_version
      using errcode = 'check_violation', constraint = 'gates_version_fixed_once_decided';
  end if;
end;
$$;

create unique index evidence_packs_id_version_idx
  on public.evidence_packs (business_id, id, version_id);

-- The gate's pack is a pack of the gate's version.
alter table public.gates
  add constraint gates_pack_in_same_version
    foreign key (business_id, evidence_pack_id, version_id)
    references public.evidence_packs (business_id, id, version_id);

create function public.gates_version_fixed_once_decided() returns trigger
  language plpgsql
  as $$
begin
  -- The update is the writer's and passed row security on `gates`, so the
  -- setting names this gate's business and its decision is visible here.
  if old.state <> 'pending'
     or exists (select 1 from public.gate_decisions d
                 where d.business_id = old.business_id and d.gate_id = old.id) then
    raise exception 'gates: gate % in business % is decided and keeps version %',
      old.id, old.business_id, old.version_id
      using errcode = 'check_violation', constraint = 'gates_version_fixed_once_decided';
  end if;
  return new;
end;
$$;

revoke execute on function public.gates_version_fixed_once_decided() from public;

create trigger gates_version_fixed_once_decided
  before update of version_id on public.gates
  for each row
  when (new.version_id is distinct from old.version_id)
  execute function public.gates_version_fixed_once_decided();
