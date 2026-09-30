-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0056 access endings (C58, CS-2.25). A person's access ended in one act:
-- `access.end` ends the membership, the person's acting identity, every live
-- grant and delegation in one transaction, and writes one row here for each
-- login mapped to the person. The row holds the two steps still owed to the
-- sign-in provider: ending every session (which revokes the refresh tokens)
-- and deactivating the login.
--
-- The local state is authoritative from the commit: login resolution already
-- refuses an ended membership and an inactive actor, so the person's next call
-- is refused whatever the provider has or has not done. The provider steps are
-- retried until each is done, and a step done is stamped once and never asked
-- again (TR-SEC5-4).
--
-- `attempt_started_at` is a short claim: a retry takes the row only when no
-- other retry has taken it lately, so two retries never call the provider for
-- one ending at once. `last_fault` is the kind of the last failure and nothing
-- else: the provider's own words, which could carry anything, go nowhere.
--
-- Written by `access.end` and by the retry; never deleted.

create table public.access_endings (
  business_id           uuid        not null,
  id                    uuid        not null default gen_random_uuid(),
  person_id             uuid        not null,
  login_id              uuid        not null,
  ended_by_actor_id     uuid        not null,
  ended_at              timestamptz not null default now(),
  sessions_ended_at     timestamptz,
  login_deactivated_at  timestamptz,
  attempts              integer     not null default 0,
  attempt_started_at    timestamptz,
  last_fault            text,
  constraint access_endings_pkey primary key (id),
  constraint access_endings_tenant_id_key unique (business_id, id),
  constraint access_endings_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint access_endings_person_fkey foreign key (business_id, person_id)
    references public.people (business_id, id),
  constraint access_endings_login_fkey foreign key (business_id, login_id)
    references public.logins (business_id, id),
  constraint access_endings_ended_by_fkey foreign key (business_id, ended_by_actor_id)
    references public.actors (business_id, id),
  constraint access_endings_attempts_counted check (attempts >= 0),
  constraint access_endings_fault_known check (
    last_fault is null
    or last_fault in ('refused', 'malformed', 'oversized', 'slow', 'unreachable')
  )
);

-- What the retry looks for: an ending with a step still owed.
create index access_endings_owed on public.access_endings (business_id)
  where sessions_ended_at is null or login_deactivated_at is null;

alter table public.access_endings enable row level security;
alter table public.access_endings force row level security;

create policy tenancy_access_endings on public.access_endings
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_access_endings on public.access_endings
  as permissive
  for all
  using (true)
  with check (true);

-- No delete: an ending is part of the person's history.
grant select, insert, update on public.access_endings to ops_astro_app;
