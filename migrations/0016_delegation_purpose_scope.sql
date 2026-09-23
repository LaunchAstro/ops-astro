-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0016 the delegation carries the one task it was minted for.
--
-- The accepted actor case is R5, "R1's delegated agent, purpose-scoped to one
-- task", and the transaction contract requires the purpose check on every
-- operation. 0008's row carries collections, actions and a purpose label, none
-- of which names a resource, so a call on a sibling task is indistinguishable
-- from a call on the picked-up one: R1 holds a business-wide task grant, so
-- both pass. The purpose was a word, not a ceiling.
--
-- Two columns make it durable. `purpose_scope_kind` is `record` and only
-- `record`, because record- and actor-scoped minting stays deferred and a
-- column that already admits other values would be pretending otherwise; the
-- check is the honest narrower statement, and widening it later is a
-- migration. `purpose_scope_id` is the picked-up task's record id.
--
-- Both are `not null` with no default. The live table holds 0 rows, so there
-- is nothing to backfill and no default to invent -- and a default here would
-- be a delegation scoped to a task nobody chose, which is the failure the
-- columns exist to prevent.

alter table public.delegations
  add column purpose_scope_kind text not null,
  add column purpose_scope_id   uuid not null;

alter table public.delegations
  add constraint delegations_purpose_scope_kind_known
    check (purpose_scope_kind = 'record');

-- The delegations a given task has outstanding, which is the question handback
-- and revocation ask.
create index delegations_purpose_scope_idx
  on public.delegations (business_id, purpose_scope_kind, purpose_scope_id)
  where revoked_at is null and settled_at is null;
