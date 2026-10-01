-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0217 a provider lookup in flight holds a slot on its route (AW-10, AW-01).
--
-- The reconciliation pass asks a provider about a call held as unknown
-- liability (`reconcileProviderCalls`, core-custody/src/broker-reconcile.ts).
-- The lookup goes out under the gate a model call takes, and until now it
-- held nothing the gate counts: two passes, or a pass and a model call, could
-- each see the route's last place free and the route ran one over its
-- ceiling. A lookup now takes a slot on the asked call's own row before
-- anything is sent:
--   lookup_until  when the slot stops counting. The pass writes it under the
--                 route's lock and the business's, in the transaction that
--                 found room, and clears it when the lookup ends, with or
--                 without proof, or when custody throws. A worker lost while
--                 asking clears nothing, so the slot counts until this time:
--                 the operation's timeout plus a margin of 60 seconds
--                 (`SLOT_MARGIN_MS` in broker-reconcile.ts).
-- A call counts on its route and against its business's ceiling for the
-- operation while it is held or sent, as before, or while its slot is
-- unexpired. `model_route_room` is replaced to count the slot too; its
-- grants, owner, definer rights and `row_security = off` are kept as 0191
-- set them, and its answer is still only 1 or 0.
-- No table, role or grant is added: the slot lives on the call's row, under
-- its business's row security and the grants the call already carries.

alter table public.model_calls add column lookup_until timestamptz;

-- A slot is only ever taken on a call once held as unknown liability.
alter table public.model_calls add constraint model_calls_lookup_slot_was_held
  check (lookup_until is null or unknown_since is not null);

create index model_calls_lookup_slot_idx
  on public.model_calls (route_key)
  where lookup_until is not null;

-- 0191's function, with the unexpired slot counted as in flight beside the
-- held and sent calls. `create or replace` keeps the owner and the grants
-- (PUBLIC revoked, `ops_astro_broker` alone executes); the clauses below
-- restate 0191's definer rights, search path and `row_security = off`.
create or replace function public.model_route_room(route text, route_ceiling integer)
  returns integer
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  set row_security = off
as $$
  with here as (
    select public.app_business_id() as business_id
  ),
  flight as (
    select count(*)::integer as total,
           count(distinct c.business_id)::integer as holding,
           (count(*) filter (where c.business_id = (select business_id from here)))::integer as mine
      from public.model_calls c
     where c.route_key = route
       and (c.state in ('reserved', 'dispatched') or c.lookup_until > clock_timestamp())
  )
  select case
           when (select business_id from here) is null then 0
           when route_ceiling is null or route_ceiling < 1 then 0
           when f.total >= route_ceiling then 0
           when f.mine >= greatest(1, route_ceiling
                  / (f.holding + case when f.mine = 0 then 1 else 0 end)) then 0
           else 1
         end
    from flight f
$$;
