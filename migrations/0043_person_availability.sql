-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0043 a person's availability (MP-7-10, CS-7.27).
--
-- One row a person, set by that person alone (`availability set`, their own
-- account; no agent) and read by their teammates in the Team panel. Away
-- carries an optional reason; available carries none, so clearing it clears
-- the reason. A person with no row is available. The audit event is the
-- history; this row is only the current state.

create table public.person_availability (
  business_id uuid        not null,
  person_id   uuid        not null,
  state       text        not null,
  reason      text,
  set_at      timestamptz not null default now(),
  constraint person_availability_pkey primary key (business_id, person_id),
  constraint person_availability_person_fkey foreign key (business_id, person_id)
    references public.people (business_id, id),
  constraint person_availability_state check (state in ('available', 'away')),
  constraint person_availability_reason check (
    (state = 'available' and reason is null)
    or (state = 'away' and (reason is null or char_length(reason) between 1 and 140))
  )
);

alter table public.person_availability enable row level security;
alter table public.person_availability force row level security;

create policy tenancy_person_availability on public.person_availability
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_person_availability on public.person_availability
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.person_availability to ops_astro_app;
