-- SPDX-License-Identifier: AGPL-3.0-only
--
-- AW-11: one sub-delegation, depth one, strictly narrower than its parent.
-- A child names its parent; the application role admits one only against a
-- live parent and within it (the U6 fallback: the subset is held here, never
-- by a token's claims).

alter table public.delegations
  add column parent_delegation_id uuid;

alter table public.delegations
  add constraint delegations_parent_fkey foreign key (business_id, parent_delegation_id)
    references public.delegations (business_id, id);

create index delegations_parent_idx
  on public.delegations (business_id, parent_delegation_id)
  where parent_delegation_id is not null;

-- A child is admitted only against a live parent of this business, at depth
-- one, drawing on the parent's person, authoriser and record, and strictly
-- inside the parent's operation set: every collection and every action the
-- parent's, and at least one of the two fewer. Read under a share lock, so a
-- revocation in flight either commits first (and the child is refused) or
-- waits for the child's transaction. Invoker's rights: row security keeps the
-- parent to this business.
create function public.delegations_child_within_parent() returns trigger
  language plpgsql
  as $$
declare
  parent public.delegations%rowtype;
begin
  if new.parent_delegation_id is null then
    return new;
  end if;
  select * into parent from public.delegations p
   where p.business_id = new.business_id and p.id = new.parent_delegation_id
     and p.revoked_at is null and p.settled_at is null and p.expires_at > now()
   for share;
  if not found then
    raise exception 'delegations: a child needs a live parent in this business'
      using errcode = 'check_violation';
  end if;
  if parent.parent_delegation_id is not null then
    raise exception 'delegations: depth one, a child has no child'
      using errcode = 'check_violation';
  end if;
  if new.delegate_person_id <> parent.delegate_person_id
     or new.minted_by_actor_id <> parent.minted_by_actor_id
     or new.purpose_scope_kind <> parent.purpose_scope_kind
     or new.purpose_scope_id <> parent.purpose_scope_id then
    raise exception 'delegations: a child draws on its parent''s person, authoriser and record'
      using errcode = 'check_violation';
  end if;
  if not (new.collections <@ parent.collections and new.actions <@ parent.actions)
     or (new.collections @> parent.collections and new.actions @> parent.actions) then
    raise exception 'delegations: a child''s operation set is a strict subset of its parent''s'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.delegations_child_within_parent() from public;

create trigger delegations_child_within_parent
  before insert on public.delegations
  for each row execute function public.delegations_child_within_parent();

-- The operation set is fixed at mint, with what it is checked against: the
-- purpose, its scope, the person, the authoriser and the parent. Widening a
-- parent would widen the ceiling its children were admitted under; widening a
-- child would step outside it. Only the lifecycle moves: the lease's
-- heartbeat (`expires_at`), revocation and its cause, settlement. After the
-- row is formed, so a named check constraint (`delegations_never_decide`)
-- still reports first.
create function public.delegations_set_is_fixed() returns trigger
  language plpgsql
  as $$
begin
  if new.purpose is distinct from old.purpose
     or new.collections is distinct from old.collections
     or new.actions is distinct from old.actions
     or new.purpose_scope_kind is distinct from old.purpose_scope_kind
     or new.purpose_scope_id is distinct from old.purpose_scope_id
     or new.delegate_person_id is distinct from old.delegate_person_id
     or new.minted_by_actor_id is distinct from old.minted_by_actor_id
     or new.parent_delegation_id is distinct from old.parent_delegation_id then
    raise exception 'delegations: the operation set, its scope, person and parent are fixed at mint'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

revoke execute on function public.delegations_set_is_fixed() from public;

create trigger delegations_set_is_fixed
  after update on public.delegations
  for each row execute function public.delegations_set_is_fixed();
