-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0056 standing mandates: graduation and standing approvals per client
-- (MP-14-10a, U39; owner answer 13).
--
-- `graduation_classes` is one action class's record for one client: what the
-- class is, the clearance rung it sits on, the decisions it has earned so far
-- (three counts, never a score) and the state that record earned: `ready`
-- (clears the bar), `short`, `mixed`, `never` (with which rule stopped it) or
-- `none`. The record is written by the agent loops as decisions land (AW-01,
-- not built); tests seed it as the owner. The application role may read it
-- and bump its revision, which is how promoting and demoting serialise on the
-- one row and how a stale switch is told so. Whether a class runs unattended
-- is not stored here: it is derived from the mandates below.
--
-- `standing_mandates` is the structured approval a person files: action
-- classes and one client, both picked from lists, a value ceiling in minor
-- units and its currency, an expiry, and a plain-language sentence that is its
-- label and nothing more (no model reads it). A refusal carries the same
-- classes, client and expiry and no ceiling, and holds the classes it matches.
-- Promoting a class for a client files a mandate for exactly that class and
-- names it in `graduation_class`; demoting revokes it. Revoking stops the
-- classes being pre-approved at once; an effect already past its gate is not
-- undone. A mandate is never edited: it is filed, and it is revoked.
--
-- Core checks class, client, ceiling, expiry and revocation at every effect,
-- reading these rows under a share lock, so a revoke either waits for an
-- effect already checking or is seen by the next one.

create table public.graduation_classes (
  business_id  uuid        not null,
  id           uuid        not null,
  client_id    uuid        not null,
  client_label text        not null,
  action_class text        not null,
  class_label  text        not null,
  clearance    text        not null default '',
  earned       text        not null,
  never_why    text,
  approved     integer     not null default 0,
  edited       integer     not null default 0,
  rejected     integer     not null default 0,
  since        date,
  note         text        not null default '',
  revision     bigint      not null default 1,
  constraint graduation_classes_pkey primary key (id),
  constraint graduation_classes_tenant_id_key unique (business_id, id),
  constraint graduation_classes_one_per_client_class unique (business_id, client_id, action_class),
  constraint graduation_classes_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint graduation_classes_class_shape
    check (action_class ~ '^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,3}$'),
  constraint graduation_classes_labels_length
    check (char_length(client_label) between 1 and 200 and char_length(class_label) between 1 and 200),
  constraint graduation_classes_earned_known
    check (earned in ('ready', 'short', 'mixed', 'never', 'none')),
  constraint graduation_classes_never_names_why
    check ((earned = 'never') = (never_why is not null)),
  constraint graduation_classes_never_why_known check (never_why in ('ceiling', 'audience')),
  constraint graduation_classes_counts_whole check (approved >= 0 and edited >= 0 and rejected >= 0),
  constraint graduation_classes_revision_positive check (revision >= 1)
);

create table public.standing_mandates (
  business_id          uuid        not null,
  id                   uuid        not null,
  client_id            uuid        not null,
  classes              text[]      not null,
  refuses              boolean     not null,
  ceiling_minor        bigint,
  currency             text,
  expires_at           timestamptz not null,
  label                text        not null,
  graduation_class     text,
  authored_by_actor_id uuid        not null,
  created_at           timestamptz not null default now(),
  revoked_at           timestamptz,
  revoked_by_actor_id  uuid,
  revision             bigint      not null default 1,
  constraint standing_mandates_pkey primary key (id),
  constraint standing_mandates_tenant_id_key unique (business_id, id),
  constraint standing_mandates_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint standing_mandates_author_fkey foreign key (business_id, authored_by_actor_id)
    references public.actors (business_id, id),
  constraint standing_mandates_revoker_fkey foreign key (business_id, revoked_by_actor_id)
    references public.actors (business_id, id),
  constraint standing_mandates_classes_listed
    check (cardinality(classes) between 1 and 20 and array_position(classes, null) is null),
  -- A refusal has no ceiling; an approval has one, in one currency.
  constraint standing_mandates_ceiling_only_on_approval check (refuses = (ceiling_minor is null)),
  constraint standing_mandates_ceiling_has_currency check ((ceiling_minor is null) = (currency is null)),
  constraint standing_mandates_ceiling_whole check (ceiling_minor >= 0),
  constraint standing_mandates_currency_shape check (currency ~ '^[A-Z]{3}$'),
  constraint standing_mandates_expires_after_filing check (expires_at > created_at),
  constraint standing_mandates_label_length check (char_length(label) between 1 and 500),
  constraint standing_mandates_graduation_is_one_class
    check (graduation_class is null or (not refuses and classes = array[graduation_class])),
  constraint standing_mandates_revoked_by_someone
    check ((revoked_at is null) = (revoked_by_actor_id is null)),
  constraint standing_mandates_revision_positive check (revision >= 1)
);

create index standing_mandates_live_idx
  on public.standing_mandates (business_id, client_id) where revoked_at is null;

alter table public.graduation_classes enable row level security;
alter table public.graduation_classes force row level security;
alter table public.standing_mandates enable row level security;
alter table public.standing_mandates force row level security;

create policy tenancy_graduation_classes on public.graduation_classes
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_graduation_classes on public.graduation_classes
  as permissive for all using (true) with check (true);

create policy tenancy_standing_mandates on public.standing_mandates
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_standing_mandates on public.standing_mandates
  as permissive for all using (true) with check (true);

grant select, update (revision) on public.graduation_classes to ops_astro_app;
grant select, insert, update (revoked_at, revoked_by_actor_id, revision)
  on public.standing_mandates to ops_astro_app;
