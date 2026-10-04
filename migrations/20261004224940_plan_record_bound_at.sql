-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 20261004115154 a plan record's `bound_at` is the database's clock, never the
-- writer's (catalogue #436). AW-06 binds a record to its decision only when it
-- was written in the decision's transaction, read as `bound_at = decided_at`
-- (both the transaction's `now()`), and placement orders records by
-- `bound_at`. 0102 let the inserting statement choose `bound_at`, so any code
-- holding the application role could insert a correctly hashed record after
-- the approval with the decision's instant copied in, and AW-06 projected it
-- as the approved plan.
--
-- The server now fills `bound_at` on insert with the transaction's clock,
-- whatever the statement supplies. A record written later carries its own
-- later instant and is never bound to an earlier decision. Rows already
-- written keep theirs.

create or replace function public.plan_records_bound_now()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  new.bound_at := now();
  return new;
end;
$$;

revoke all on function public.plan_records_bound_now() from public;

create trigger plan_records_bound_now
  before insert on public.plan_records
  for each row execute function public.plan_records_bound_now();
