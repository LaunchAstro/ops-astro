-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0025 the committed total under a cap never exceeds its ceiling at commit.
--
-- 0013 bounds each envelope by its own `maximum_minor`, but nothing in storage
-- bounds the envelopes of one cap together. `task.decide` and `task.pickup`
-- compare the cap's committed total with its limit exactly, under the cap lock
-- (`core-runtime/src/budget.ts`, `BUDGET_EXHAUSTED`), and that is the only
-- place the ceiling is held. A writer that skips the command, or two
-- transactions that each fit alone and neither takes the lock, can commit a
-- total past the limit. Nathan approved a storage backstop: whatever path
-- writes them, the committed holds under a cap never exceed its ceiling.
--
-- The committed total is the one the code reads: `sum(held_minor +
-- actual_minor)` over every envelope that draws on the cap, open or closed.
-- A deferred constraint trigger judges it at commit, so a transaction may pass
-- through a larger total on its way to a valid one. It claims the cap row
-- before it sums, by writing it unchanged: a lock alone does not refresh a
-- repeatable read or serializable snapshot, but a new row version does. Of two
-- committing transactions the second waits for the first. Under read committed
-- its sum is a new snapshot that sees the first's rows; under repeatable read
-- or serializable, whose snapshot predates the first commit, the claim fails
-- with `serialization_failure` and the caller retries in a fresh snapshot.
-- Every command path that raises a hold already holds the cap lock
-- (`locks.ts`, second in the order), so for them the claim waits on nothing.
-- The sum is `numeric` and exact at any `bigint` limit.
--
-- Only a write that can raise the total queues a check: an envelope inserted
-- with a nonzero total, an envelope whose total grows or that moves to another
-- cap, and a limit that falls. A release never waits on the cap lock.
--
-- Additive. A constraint trigger does not look at rows already written, so the
-- same rule is checked here once against them: an installation already holding
-- a cap committed past its limit fails this migration and stays at 0024 with
-- its rows untouched. A fresh database and an upgraded one then hold the same
-- rule over the same rows. The function is revoked from public; triggers call
-- it without an execute grant. Grants are unchanged: the claim runs as the
-- writer, and the role that may write an envelope may update the cap (0013).

create function public.budget_caps_ceiling_holds() returns trigger
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
  select coalesce(sum(e.held_minor::numeric + e.actual_minor::numeric), 0) into committed
    from public.task_envelopes e
   where e.business_id = cap_business and e.cap_id = cap;
  if committed > ceiling then
    raise exception 'budget_caps: the committed total % under cap % exceeds its ceiling %',
      committed, cap, ceiling
      using errcode = 'check_violation', constraint = 'budget_caps_ceiling';
  end if;
  return null;
end;
$$;

revoke execute on function public.budget_caps_ceiling_holds() from public;

do $$
declare
  over record;
begin
  select c.business_id, c.id, c.limit_minor, sum(e.held_minor::numeric + e.actual_minor::numeric) as committed
    into over
    from public.budget_caps c
    join public.task_envelopes e on e.business_id = c.business_id and e.cap_id = c.id
   group by c.business_id, c.id, c.limit_minor
  having sum(e.held_minor::numeric + e.actual_minor::numeric) > c.limit_minor
   limit 1;
  if found then
    raise exception 'budget_caps: cap % in business % is committed to % past its ceiling %',
      over.id, over.business_id, over.committed, over.limit_minor
      using errcode = 'check_violation', constraint = 'budget_caps_ceiling';
  end if;
end;
$$;

create constraint trigger task_envelopes_insert_within_cap_ceiling
  after insert on public.task_envelopes
  deferrable initially deferred
  for each row
  when (new.held_minor + new.actual_minor > 0)
  execute function public.budget_caps_ceiling_holds();

create constraint trigger task_envelopes_update_within_cap_ceiling
  after update of held_minor, actual_minor, cap_id on public.task_envelopes
  deferrable initially deferred
  for each row
  when (new.held_minor + new.actual_minor > old.held_minor + old.actual_minor
        or (new.cap_id is distinct from old.cap_id and new.held_minor + new.actual_minor > 0))
  execute function public.budget_caps_ceiling_holds();

create constraint trigger budget_caps_limit_within_ceiling
  after update of limit_minor on public.budget_caps
  deferrable initially deferred
  for each row
  when (new.limit_minor < old.limit_minor)
  execute function public.budget_caps_ceiling_holds();
