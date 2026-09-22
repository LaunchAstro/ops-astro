-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0003 grants. Who may do what, to which collection, over what scope — and the
-- edge back to the grant it was cut from, which is what lets revoking a manager
-- collapse everything that manager issued.
--
-- One row is one action on one collection at one scope, so "no widening" is a
-- comparison between two rows rather than set algebra over a permission blob.
--
-- Three things are deliberate and each costs something.
--
-- 1. `subject_id` and `scope_id` carry no foreign key. `scope_id` is opaque by
--    ADR 0012 and `subject_id` is polymorphic across person, group and actor.
--    So revocation and record deletion are the owning operation's work, never a
--    cascade. That is the ratified shape's real cost, written where it is paid.
-- 2. There is no delete path and the application role has no DELETE privilege.
--    Revocation writes a timestamp, because deleting the row destroys the
--    evidence that access once existed, which is what an investigation needs.
-- 3. Authority is not enforced by this table's policies. The policy below is
--    the same restrictive session-setting barrier every table carries; the
--    grant check runs inside the serving transaction, where it can be
--    re-evaluated per call. A policy reading `grants` would need a join, which
--    the conformance set forbids, or a definer-rights function, which is what
--    the isolation suite's fourth case exists to attack.

create table public.grants (
  business_id           uuid        not null,
  id                    uuid        not null,

  -- Who holds it. Polymorphic, so no foreign key; the issuing operation checks.
  subject_kind          text        not null,
  subject_id            uuid        not null,

  -- Over what: ADR 0012's triple. `scope_id` is null exactly at business scope.
  scope_kind            text        not null,
  scope_id              uuid,

  collection            text        not null,
  action                text        not null,

  -- `can_delegate` lets the holder issue derived grants; `may_permit_delegation`
  -- lets those derived grants delegate in turn. It is off by default, which is
  -- the contract's "no deepening by default", and only a root grant may carry
  -- it, which is what bounds the chain.
  can_delegate          boolean     not null default false,
  may_permit_delegation boolean     not null default false,

  -- The granter's own row; null is a root grant. This is the edge the use-time
  -- re-check walks, so a revoked manager takes what they issued with them.
  parent_grant_id       uuid,

  granted_by_actor_id   uuid        not null,
  granted_at            timestamptz not null default now(),
  expires_at            timestamptz,
  revoked_at            timestamptz,

  constraint grants_pkey primary key (id),
  constraint grants_tenant_id_key unique (business_id, id),
  constraint grants_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint grants_parent_fkey foreign key (business_id, parent_grant_id)
    references public.grants (business_id, id),
  constraint grants_granted_by_fkey foreign key (business_id, granted_by_actor_id)
    references public.actors (business_id, id),

  constraint grants_subject_kind_known check (subject_kind in ('person', 'group', 'actor')),
  constraint grants_scope_kind_known check (scope_kind in ('business', 'party', 'record')),
  constraint grants_action_known check (
    action in ('read', 'comment', 'write', 'assign', 'decide', 'share', 'manage')
  ),
  -- Business scope is the whole tenant, so it carries no identifier, and every
  -- narrower scope must name one. Without this, a null `scope_id` at record
  -- scope would read as every record.
  constraint grants_scope_id_matches_kind check ((scope_kind = 'business') = (scope_id is null)),
  -- Permitting deepening without being able to delegate at all is a state with
  -- no meaning, and a state with no meaning is one a later reader guesses at.
  constraint grants_deepening_needs_delegation check (
    may_permit_delegation is false or can_delegate is true
  ),
  constraint grants_not_own_parent check (parent_grant_id is distinct from id),
  constraint grants_revoked_after_granted check (revoked_at is null or revoked_at >= granted_at)
);

-- Every check starts from who is asking, so the index does too.
create index grants_subject_idx
  on public.grants (business_id, subject_kind, subject_id, collection, action);

create index grants_parent_idx
  on public.grants (business_id, parent_grant_id)
  where parent_grant_id is not null;

alter table public.grants enable row level security;
alter table public.grants force row level security;

create policy tenancy_grants on public.grants
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

-- The permissive baseline. Authority over this table's own rows is not
-- expressible here: the chain walk must read the manager's grant as well as the
-- worker's, so a policy narrowed to the caller's own rows would break the very
-- re-check that makes revocation bite.
create policy authority_grants on public.grants
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.grants to ops_astro_app;
