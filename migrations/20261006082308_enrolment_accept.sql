-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 20261005214435 an invitation accepted on its one-time link (C39-T, piece P3).
--
-- A token moves once, by `spent_at` alone: when its invitation is accepted, or
-- when a resend or revoke ends every token before it (SEC27 F5). The accept
-- arrives with no business, and a hash is unique in its business only, so the
-- lookup is one narrow function reading every business's tokens (SEC27 F6):
-- the three ids of the one token with that hash, nulls otherwise. PUBLIC may
-- not run it; the application group alone may.

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

-- An accept claims its invitation before it asks the login provider anything
-- and binds only under its claim. Live claims are its calls in flight: per
-- business within the operations' concurrency, and within the route's ceiling
-- shared fairly as `model_route_room` (0085) shares a model route, which reads
-- every business's claims, so one narrow function answers 1 (room) or 0.
alter table public.invitations
  add column accept_claim         uuid,
  add column accept_claimed_until timestamptz;

create function public.enrolment_route_room(route_ceiling integer)
  returns integer
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  set row_security = off
as $$
  with flight as (
    select count(*)::integer as total,
           count(distinct i.business_id)::integer as holding,
           (count(*) filter (where i.business_id = public.app_business_id()))::integer as mine
      from public.invitations i
     where i.accept_claimed_until > clock_timestamp()
  )
  select case when public.app_business_id() is null or coalesce(route_ceiling, 0) < 1
                or f.total >= route_ceiling
                or f.mine >= greatest(1, route_ceiling / (f.holding + (f.mine = 0)::integer))
              then 0 else 1 end
    from flight f
$$;

revoke all on function public.enrolment_route_room(integer) from public;
grant execute on function public.enrolment_route_room(integer) to ops_astro_app;
