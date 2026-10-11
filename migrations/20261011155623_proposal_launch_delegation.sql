-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The Launch delegation a proposal version was made under, when an agent
-- made it under one. Four eyes (T2g) refuses the decision to that
-- delegation's person, the launcher: one who launched another person's agent
-- signs off nothing it proposed (`tasks/assignee.ts`). Kept on the version,
-- not read from the task's open launch, so it holds after the launch ends and
-- when someone else launches again. Null when a person proposed, or an agent
-- under a pickup's delegation, whose person reviews its output (AW-09). The
-- key is to the launch's own delegation (`task_launches_delegation_idx`).
--
-- The version stays immutable, this column with it: the trigger function is
-- restated with one more column compared.

alter table public.proposal_versions add column launch_delegation_id uuid,
  add constraint proposal_versions_launch_fkey foreign key (business_id, launch_delegation_id)
    references public.task_launches (business_id, delegation_id);

create or replace function public.proposal_versions_are_immutable() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'proposal_versions are immutable: version % cannot be deleted', old.id
      using errcode = 'restrict_violation';
  end if;
  if new.id is distinct from old.id
     or new.business_id is distinct from old.business_id
     or new.lineage_id is distinct from old.lineage_id
     or new.version is distinct from old.version
     or new.payload is distinct from old.payload
     or new.payload_digest is distinct from old.payload_digest
     or new.purpose is distinct from old.purpose
     or new.maximum_minor is distinct from old.maximum_minor
     or new.currency is distinct from old.currency
     or new.proposed_by_actor_id is distinct from old.proposed_by_actor_id
     or new.launch_delegation_id is distinct from old.launch_delegation_id
     or new.created_at is distinct from old.created_at then
    raise exception 'proposal_versions are immutable: version % cannot be edited', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at then
    raise exception 'version % is already superseded', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.proposal_versions_are_immutable() from public;
