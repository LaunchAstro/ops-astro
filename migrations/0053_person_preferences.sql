-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0053 the one preference store (MP-2-11a, U07).
--
-- One row per person and key. Appearance, the tips and the rail, dock and
-- column widths are keys here, never tables of their own (FG-O-5). The key
-- set and each key's value shape are the application's
-- (`packages/core-records/src/preferences/`), so a later part adds a key
-- without a migration. A preference is the person's own: the command that
-- writes it names no person in its body and writes the caller's row only
-- (`preference:write`, self-scoped). Protected work: this adds a table.

create table public.person_preferences (
  business_id uuid        not null,
  person_id   uuid        not null,
  key         text        not null,
  value       jsonb       not null,
  saved_at    timestamptz not null default now(),
  constraint person_preferences_pkey primary key (business_id, person_id, key),
  constraint person_preferences_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint person_preferences_person_fkey foreign key (business_id, person_id)
    references public.people (business_id, id),
  constraint person_preferences_key_shape check (key ~ '^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)*$')
);

alter table public.person_preferences enable row level security;
alter table public.person_preferences force row level security;

create policy tenancy_person_preferences on public.person_preferences
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_person_preferences on public.person_preferences
  as permissive for all using (true) with check (true);

-- A second save of a key replaces its value; nothing deletes a preference.
grant select, insert, update on public.person_preferences to ops_astro_app;
