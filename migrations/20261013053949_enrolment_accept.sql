-- SPDX-License-Identifier: AGPL-3.0-only
--
-- An invitation accepted on its one-time link (C39-T). The accept arrives with
-- no business and no sign-in: the token is its authority.
--
-- A token moves once, by `spent_at` alone, when its invitation is accepted. A
-- hash is unique in its business only, so the lookup is one narrow function
-- reading every business's tokens: the three ids of the one token with that
-- hash, nulls otherwise. PUBLIC may not run it; the application group alone
-- may.
--
-- An accepted invitation's login is owed to the login provider: the accept
-- writes the person's login under an id of ours and one owed row naming it;
-- the M5 unit, which alone holds the provider's admin key, makes the login
-- under that id and marks the row. The row names its invitation and login
-- only, so the address and subject it acts on are read through them, never
-- copied.

grant update (spent_at) on public.enrolment_tokens to ops_astro_app;

create function public.enrolment_token_find(
  hash text,
  out business_id uuid,
  out invitation_id uuid,
  out token_id uuid
)
  language sql
  stable
  security definer
  set search_path = pg_catalog
  set row_security = off
as $$
  select (array_agg(t.business_id))[1], (array_agg(t.invitation_id))[1], (array_agg(t.id))[1]
    from public.enrolment_tokens t
   where t.token_hash = hash
  having count(*) = 1
$$;

revoke all on function public.enrolment_token_find(text) from public;
grant execute on function public.enrolment_token_find(text) to ops_astro_app;

create table public.login_provisions (
  business_id   uuid        not null,
  id            uuid        not null,
  invitation_id uuid        not null,
  login_id      uuid        not null,
  state         text        not null default 'owed',
  tries         integer     not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint login_provisions_pkey primary key (id),
  constraint login_provisions_tenant_id_key unique (business_id, id),
  constraint login_provisions_invitation_key unique (business_id, invitation_id),
  constraint login_provisions_login_key unique (business_id, login_id),
  constraint login_provisions_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint login_provisions_invitation_fkey foreign key (business_id, invitation_id)
    references public.invitations (business_id, id),
  constraint login_provisions_login_fkey foreign key (business_id, login_id)
    references public.logins (business_id, id),
  constraint login_provisions_state_known check (state in ('owed', 'done', 'held')),
  constraint login_provisions_tries_counted check (tries >= 0)
);

create index login_provisions_owed_idx
  on public.login_provisions (business_id, created_at) where state = 'owed';

alter table public.login_provisions enable row level security;
alter table public.login_provisions force row level security;

create policy tenancy_login_provisions on public.login_provisions
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_login_provisions on public.login_provisions
  as permissive for all using (true) with check (true);

-- The accept writes the owed row; the unit that settles it brings its own grant.
grant select, insert on public.login_provisions to ops_astro_app;
