-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 20261005214435 an invitation accepted on its one-time link (C39-T, piece P3).
--
-- A token moves once, by `spent_at` alone: when its invitation is accepted,
-- and when a resend or a revoke ends every token minted before it, so a link
-- an email already carried does nothing after either (SEC27 F5). Nothing
-- else of a token is ever rewritten.
--
-- The accept arrives with the token and no business, and a token's hash is
-- unique in its business only (`enrolment_tokens_hash_key`), which a tenant
-- transaction cannot see past. So the lookup by hash is one narrow function
-- that reads every business's tokens (SEC27 F6): it answers the business, the
-- invitation and the token ids of the one token with that hash, and nothing
-- (nulls) when no business or more than one holds it. Nothing else about the
-- token or its invitation leaves it; the accept reads the rest in the token's
-- own business, under its tenancy. PUBLIC may not run it; the application
-- group alone may.

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
