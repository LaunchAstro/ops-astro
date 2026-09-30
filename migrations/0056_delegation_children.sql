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
