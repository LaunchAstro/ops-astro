-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0032 C59: the second factor a person has enrolled at the sign-in provider.
--
-- The provider holds the factor and its secret; this table holds only that the
-- person has one, which one (the provider's factor id, not a secret), and where
-- it stands. It is what login resolution reads to decide that a sign-in
-- without the second factor is not enough for this person, so the answer is
-- the database's, read inside the serving transaction, and not a claim a token
-- can make about itself.
--
-- A person has at most one live factor: `unverified` from enrolment until the
-- first verification completes it, then `verified`. Replacing or removing it
-- ends the row (`removed`) and never deletes it, so the history of a person's
-- factors stays readable. No secret, QR code or code a person typed is ever
-- written here: the columns cannot hold one.

create table public.second_factors (
  business_id        uuid        not null,
  id                 uuid        not null,
  person_id          uuid        not null,
  provider           text        not null,
  provider_factor_id text        not null,
  status             text        not null default 'unverified',
  enrolled_at        timestamptz not null default now(),
  verified_at        timestamptz,
  removed_at         timestamptz,
  constraint second_factors_pkey primary key (id),
  constraint second_factors_tenant_id_key unique (business_id, id),
  constraint second_factors_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint second_factors_person_fkey foreign key (business_id, person_id)
    references public.people (business_id, id),
  constraint second_factors_status_known check (status in ('unverified', 'verified', 'removed')),
  constraint second_factors_provider_present check (length(btrim(provider)) > 0),
  -- A provider factor id is an identifier, bounded and plain, so nothing
  -- secret-shaped or oversized can be stored in its place.
  constraint second_factors_factor_id_shape
    check (provider_factor_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  constraint second_factors_verified_when check (status <> 'verified' or verified_at is not null),
  constraint second_factors_removed_when check ((status = 'removed') = (removed_at is not null))
);

-- One live factor per person.
create unique index second_factors_one_live
  on public.second_factors (business_id, person_id)
  where status <> 'removed';

alter table public.second_factors enable row level security;
alter table public.second_factors force row level security;

create policy tenancy_second_factors on public.second_factors
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_second_factors on public.second_factors
  as permissive
  for all
  using (true)
  with check (true);

-- Written and moved on, never deleted.
grant select, insert, update on public.second_factors to ops_astro_app;
