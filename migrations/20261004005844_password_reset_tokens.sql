-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 20261004005844 a password reset on our own one-time token (C40, ORCH77-C40B).
--
-- The reset no longer trusts the login provider's recovery session. Its link
-- carries a token of ours: 32 random bytes, kept here as its SHA-256 alone,
-- for one login of one business, good for 30 minutes and spent once. A token
-- moves once, by `spent_at` alone, under its row's lock; nothing else of it is
-- ever rewritten, and nothing removes one.
--
-- The reset arrives with the token and no business, and a hash is unique in
-- its business only, which a tenant transaction cannot see past. So the lookup
-- by hash is one narrow function that reads every business's tokens, as
-- `enrolment_token_find` does: it answers the business and the token's id of
-- the one token with that hash, and nothing (nulls) when no business or more
-- than one holds it. Nothing else leaves it; the reset reads the rest in the
-- token's own business. PUBLIC may not run it; the application group alone may.
--
-- A subject-wide ending (0063) now ends sessions up to the moment its row is
-- written (`clock_timestamp()`), not the start of its transaction, so a
-- session opened while that transaction ran is ended with the rest (Sol, PR
-- #382 round 1).

create table public.password_reset_tokens (
  business_id uuid        not null,
  id          uuid        not null,
  login_id    uuid        not null,
  -- SHA-256 of the token, lower-case hex. Never the token.
  token_hash  text        not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  spent_at    timestamptz,
  constraint password_reset_tokens_pkey primary key (id),
  constraint password_reset_tokens_tenant_id_key unique (business_id, id),
  constraint password_reset_tokens_hash_key unique (business_id, token_hash),
  constraint password_reset_tokens_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint password_reset_tokens_login_fkey foreign key (business_id, login_id)
    references public.logins (business_id, id),
  constraint password_reset_tokens_hash_shape check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint password_reset_tokens_short_life
    check (expires_at > created_at and expires_at <= created_at + interval '30 minutes')
);

create index password_reset_tokens_login_idx
  on public.password_reset_tokens (business_id, login_id) where spent_at is null;

alter table public.password_reset_tokens enable row level security;
alter table public.password_reset_tokens force row level security;

create policy tenancy_password_reset_tokens on public.password_reset_tokens
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_password_reset_tokens on public.password_reset_tokens
  as permissive for all using (true) with check (true);

grant select, insert on public.password_reset_tokens to ops_astro_app;
grant update (spent_at) on public.password_reset_tokens to ops_astro_app;

create function public.password_reset_token_find(
  hash text,
  out business_id uuid,
  out token_id uuid
)
  language sql
  stable
  security definer
  set search_path = pg_catalog
  set row_security = off
as $$
  select (array_agg(t.business_id))[1], (array_agg(t.id))[1]
    from public.password_reset_tokens t
   where t.token_hash = hash
  having count(*) = 1
$$;

revoke all on function public.password_reset_token_find(text) from public;
grant execute on function public.password_reset_token_find(text) to ops_astro_app;

alter table ops.ended_subject_sessions alter column ended_before set default clock_timestamp();
