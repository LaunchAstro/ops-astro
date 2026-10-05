-- SPDX-License-Identifier: AGPL-3.0-only
-- A UTC timestamp ID (docs/local/DATA.md, "What the schema is"): ported from
-- b0/SL13's 0035 (0254 at its head) after migrations moved to timestamps.
--
-- standing mandates: graduation and standing approvals per client
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
-- Both tables name a client of the same business by foreign key (`clients`,
-- 0055), so neither can point at another business's client, and the name the
-- region shows is the client's own.
--
-- A mandate's words are the three a client's scope list offers, and nothing
-- else: the whole-account word `*`, a family word (`social.*`) or one action
-- class, each checked whole by `standing_mandate_words_known`, so no word that
-- matches nothing can be filed as a refusal that holds nothing.
--
-- Core checks class, client, ceiling, expiry and revocation at every effect.
-- It share-locks the client's row, then that class's graduation row, then the
-- client's not-revoked mandates; every mandate filed takes the client's row
-- `for no key update` in its own insert (`standing_mandates_lock_client`), and
-- the mandate writers take it first. So a revoke, or a refusal filed, either
-- waits for an effect already checking or is seen by the next one. A mandate
-- is written once: `standing_mandates_written_once` refuses any change but its
-- revocation, which the database stamps, moves the revision by one, and is
-- never undone.

-- Each word of a mandate's list, whole: `*`, a family word or an action class
-- in `graduation_classes_class_shape`'s form.
create function public.standing_mandate_words_known(words text[]) returns boolean
  language sql immutable
  set search_path = pg_catalog
  as $$
    select coalesce(bool_and(coalesce(
             word = '*'
             or word ~ '^[a-z][a-z0-9_]{0,31}\.\*$'
             or word ~ '^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,3}$', false)), false)
      from unnest(words) as word
  $$;

revoke execute on function public.standing_mandate_words_known(text[]) from public;
grant execute on function public.standing_mandate_words_known(text[]) to ops_astro_app;

create table public.graduation_classes (
  business_id  uuid        not null,
  id           uuid        not null,
  client_id    uuid        not null,
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
  constraint graduation_classes_client_fkey foreign key (business_id, client_id)
    references public.clients (business_id, id),
  constraint graduation_classes_class_shape
    check (action_class ~ '^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,3}$'),
  constraint graduation_classes_label_length check (char_length(class_label) between 1 and 200),
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
  constraint standing_mandates_client_fkey foreign key (business_id, client_id)
    references public.clients (business_id, id),
  constraint standing_mandates_author_fkey foreign key (business_id, authored_by_actor_id)
    references public.actors (business_id, id),
  constraint standing_mandates_revoker_fkey foreign key (business_id, revoked_by_actor_id)
    references public.actors (business_id, id),
  constraint standing_mandates_classes_listed
    check (cardinality(classes) between 1 and 20 and array_position(classes, null) is null),
  constraint standing_mandates_words_known check (public.standing_mandate_words_known(classes)),
  -- A refusal has no ceiling; an approval has one, in one currency.
  constraint standing_mandates_ceiling_only_on_approval check (refuses = (ceiling_minor is null)),
  constraint standing_mandates_ceiling_has_currency check ((ceiling_minor is null) = (currency is null)),
  -- Whole minor units a JavaScript number holds exactly, so core compares them exactly.
  constraint standing_mandates_ceiling_whole check (ceiling_minor between 0 and 9007199254740991),
  constraint standing_mandates_currency_shape check (currency ~ '^[A-Z]{3}$'),
  constraint standing_mandates_expires_after_filing check (expires_at > created_at),
  constraint standing_mandates_label_length check (char_length(label) between 1 and 500),
  constraint standing_mandates_graduation_is_one_class
    check (graduation_class is null or (not refuses and classes = array[graduation_class]
           and graduation_class ~ '^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,3}$')),
  constraint standing_mandates_revoked_by_someone
    check ((revoked_at is null) = (revoked_by_actor_id is null)),
  constraint standing_mandates_revision_positive check (revision >= 1)
);

create index standing_mandates_live_idx
  on public.standing_mandates (business_id, client_id) where revoked_at is null;

create function public.standing_mandates_written_once() returns trigger
  language plpgsql
  as $$
  begin
    if (new.business_id, new.id, new.client_id, new.classes, new.refuses, new.ceiling_minor,
        new.currency, new.expires_at, new.label, new.graduation_class,
        new.authored_by_actor_id, new.created_at)
       is distinct from
       (old.business_id, old.id, old.client_id, old.classes, old.refuses, old.ceiling_minor,
        old.currency, old.expires_at, old.label, old.graduation_class,
        old.authored_by_actor_id, old.created_at)
       or (old.revoked_at is not null
           and (new.revoked_at, new.revoked_by_actor_id)
               is distinct from (old.revoked_at, old.revoked_by_actor_id))
       or new.revision is distinct from old.revision + 1 then
      raise exception 'IMMUTABLE_FIELD: a standing mandate is written once'
        using errcode = 'restrict_violation';
    end if;
    -- The revocation's time is the database's, read after the row lock.
    if old.revoked_at is null and new.revoked_at is not null then
      new.revoked_at := clock_timestamp();
    end if;
    return new;
  end;
  $$;

revoke execute on function public.standing_mandates_written_once() from public;

create trigger standing_mandates_written_once
  before update on public.standing_mandates
  for each row execute function public.standing_mandates_written_once();

-- Every mandate filed takes its client's row first, in the insert itself, so
-- a refusal waits for a check already holding that row and the next check
-- sees it, whichever writer files it.
create function public.standing_mandates_lock_client() returns trigger
  language plpgsql
  as $$
  begin
    perform 1 from public.clients
      where business_id = new.business_id and id = new.client_id
      for no key update;
    return new;
  end;
  $$;

revoke execute on function public.standing_mandates_lock_client() from public;

create trigger standing_mandates_lock_client
  before insert on public.standing_mandates
  for each row execute function public.standing_mandates_lock_client();

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
-- Filed with its own fields only: `created_at` is the database's, and a
-- mandate is filed live, at revision 1.
grant select, update (revoked_at, revoked_by_actor_id, revision),
  insert (business_id, id, client_id, classes, refuses, ceiling_minor, currency, expires_at, label,
          graduation_class, authored_by_actor_id)
  on public.standing_mandates to ops_astro_app;
