-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0029 the cap ceiling fails closed when the cap cannot be read at commit.
--
-- 0025's deferred trigger judges the committed total under a cap at commit,
-- as the writer and under row security. It reads the tenancy setting the
-- transaction holds at commit, not the one the write was made under, and the
-- application role may change `app.business_id` in between: cleared, or set to
-- another business. The claim then matched no row, `ceiling` stayed NULL, the
-- sum saw no envelope, `committed > NULL` was NULL rather than true, and an
-- over-ceiling total committed (final review round 2, R2-RUNTIME-6 and
-- R2-AUTHORITY-20). Nathan approved this migration.
--
-- The cap always exists: `task_envelopes_cap_fkey` (0013) names it, and the
-- trigger on `budget_caps` fires for the row being written. So a claim that
-- finds nothing means the cap is hidden, and a ceiling that cannot be read is
-- not room (RUNTIME.md, thermo O2): the commit is refused `budget_caps_ceiling`
-- whether or not the hidden total would have fitted. The comparison fails
-- closed on NULL as well. Everything else is 0025's, unchanged: the claim, the
-- sum, the message, the triggers and the grants. A transaction that keeps its
-- setting, which every command path does, is judged exactly as before.
--
-- Additive. Rows already written were judged by 0025's check when it applied
-- and by its trigger since, and this function reads the same total, so there
-- is nothing to check again. `create or replace` keeps the function's owner
-- and privileges; the public execute revoke is repeated so the migration
-- states it.

create or replace function public.budget_caps_ceiling_holds() returns trigger
  language plpgsql
  as $$
declare
  cap_business public.budget_caps.business_id%type;
  cap public.budget_caps.id%type;
  ceiling public.budget_caps.limit_minor%type;
  committed numeric;
begin
  if tg_table_name = 'budget_caps' then
    cap_business := new.business_id;
    cap := new.id;
  else
    cap_business := new.business_id;
    cap := new.cap_id;
  end if;
  -- The claim first, as its own statement: the sum below then reads every
  -- envelope a transaction that claimed the cap before this one committed, or
  -- this transaction fails. The limit is written unchanged, so the trigger on
  -- `budget_caps` below, which fires only when the limit falls, does not queue.
  update public.budget_caps c
     set limit_minor = c.limit_minor
   where c.business_id = cap_business and c.id = cap
  returning c.limit_minor into ceiling;
  -- The cap exists, so not finding it means row security hides it under the
  -- setting held at commit. Its ceiling cannot be read, and that is not room.
  if not found then
    raise exception 'budget_caps: cap % in business % cannot be read at commit',
      cap, cap_business
      using errcode = 'check_violation', constraint = 'budget_caps_ceiling';
  end if;
  select coalesce(sum(e.held_minor::numeric + e.actual_minor::numeric), 0) into committed
    from public.task_envelopes e
   where e.business_id = cap_business and e.cap_id = cap;
  if not (committed <= ceiling) or ceiling is null then
    raise exception 'budget_caps: the committed total % under cap % exceeds its ceiling %',
      committed, cap, ceiling
      using errcode = 'check_violation', constraint = 'budget_caps_ceiling';
  end if;
  return null;
end;
$$;

revoke execute on function public.budget_caps_ceiling_holds() from public;
