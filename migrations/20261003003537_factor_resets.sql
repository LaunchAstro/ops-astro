-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0100 factor resets (C59, ORCH65-Q3). The number is a placeholder: it is
-- renumbered when this lands, after whatever migrations land first.
--
-- A member who has lost their authenticator cannot clear it themselves:
-- the provider refuses a new enrolment, and the removal of a verified
-- factor, below `aal2`. So `access.reset_factor` lets the owner clear it. In
-- one transaction under the access lock the member's live factor is recorded
-- removed (0049, 0064), their sessions are ended (0057, 0063), and one row is
-- written here: the step still owed to the provider, its admin removal of
-- that factor (`DELETE /admin/users/<subject>/factors/<id>`). The step is
-- never taken inside a transaction. The local server, where it holds the
-- provider's admin key, tries it once the act commits, and the endings loop
-- (the only hosted holder of that key) retries it until it is done. Done is
-- stamped once and never asked again.
--
-- `attempt_started_at` is a short claim, as 0056's: a retry takes the row
-- only when no other has taken it lately, so two never call the provider for
-- one reset at once. `last_fault` is the kind of the last failure and nothing
-- else. The provider factor id is an identifier, shaped as 0049 shapes it.
--
-- Written by `access.reset_factor` and by the retry; never deleted.

create table public.factor_resets (
  business_id         uuid        not null,
  id                  uuid        not null default gen_random_uuid(),
  person_id           uuid        not null,
  login_id            uuid        not null,
  reset_by_actor_id   uuid        not null,
  provider_factor_id  text        not null,
  reset_at            timestamptz not null default now(),
  done_at             timestamptz,
  attempts            integer     not null default 0,
  attempt_started_at  timestamptz,
  last_fault          text,
  constraint factor_resets_pkey primary key (id),
  constraint factor_resets_tenant_id_key unique (business_id, id),
  constraint factor_resets_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint factor_resets_person_fkey foreign key (business_id, person_id)
    references public.people (business_id, id),
  constraint factor_resets_login_fkey foreign key (business_id, login_id)
    references public.logins (business_id, id),
  constraint factor_resets_reset_by_fkey foreign key (business_id, reset_by_actor_id)
    references public.actors (business_id, id),
  constraint factor_resets_factor_id_shape check (provider_factor_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  constraint factor_resets_attempts_counted check (attempts >= 0),
  constraint factor_resets_fault_known check (
    last_fault is null
    or last_fault in ('refused', 'malformed', 'oversized', 'slow', 'unreachable')
  )
);

-- What the retry looks for: a reset with its provider step still owed.
create index factor_resets_owed on public.factor_resets (business_id) where done_at is null;

alter table public.factor_resets enable row level security;
alter table public.factor_resets force row level security;

create policy tenancy_factor_resets on public.factor_resets
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_factor_resets on public.factor_resets
  as permissive
  for all
  using (true)
  with check (true);

-- No delete: a reset is part of the person's history.
grant select, insert, update on public.factor_resets to ops_astro_app;

-- Whether a provider subject is live in a business other than the tenant
-- transaction's own: a login of that subject elsewhere, mapped to a person,
-- whose access has not been ended there (C58's `loginLiveElsewhere`, asked
-- here from inside the command's transaction, which the hosted API serves
-- without the owner's login). A reset there would clear that business's
-- sign-in too, so the command refuses it.
--
-- It runs as its definer with row security off, the one way to see past the
-- tenant, and is kept narrow on purpose:
--   * it answers one boolean: no id, business, person or count;
--   * the business is the transaction's own (`app_business_id`), never an
--     argument; with none set the answer is true, which refuses;
--   * PUBLIC may not execute it; only the application's group may;
--   * its search path is pinned.
-- With an owner that does not bypass row security the query is refused rather
-- than answered from one business's rows: `row_security = off` fails closed.
create function public.factor_login_live_elsewhere(subject text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  set row_security = off
as $$
  select case
           when public.app_business_id() is null then true
           else exists (
             select 1
               from public.logins l
               join public.person_logins m
                 on m.business_id = l.business_id and m.login_id = l.id and m.active
              where l.provider = 'supabase' and l.subject = factor_login_live_elsewhere.subject
                and l.business_id <> public.app_business_id()
                and not exists (
                  select 1 from public.access_endings e
                   where e.business_id = l.business_id and e.login_id = l.id))
         end
$$;

revoke all on function public.factor_login_live_elsewhere(text) from public;
grant execute on function public.factor_login_live_elsewhere(text) to ops_astro_app;
