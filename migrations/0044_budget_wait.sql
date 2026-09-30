-- SPDX-License-Identifier: AGPL-3.0-only
--
-- AW-05: the budget wait. The approved ceiling is the stop. A model call that
-- would take a run past its reservation is refused, and in the same
-- transaction the run stops and asks (`core-runtime/src/budget-wait.ts`).
--
--   planned_runs.state  gains `waiting_budget`. It is entered from `claimed`
--                       only, and nothing leaves it: no machine path turns
--                       the wait into failed, cancelled or done. A person's
--                       answer (top-up or end, the next increment of AW-05)
--                       is the one way out, and it widens this trigger.
--   budget_asks         one row per stop: the run, the reservation it held,
--                       the lease that reached it, the decision that
--                       approved the plan, the ceiling and the spend to date.
--                       The rows are the persisted ask count, so a restart
--                       keeps it. A run asks three times at most, and the
--                       third ask is the consolidated decision (execution
--                       decisions 15.2): the database refuses a fourth.
--
-- The application group may insert and read an ask and may never update or
-- delete one. The worker and broker roles hold nothing on it.
-- Numbered after main's 0041 at the rebase; the batch integration may number it again.

alter table public.planned_runs drop constraint planned_runs_state_known;
alter table public.planned_runs
  add constraint planned_runs_state_known
    check (state in ('planned', 'claimed', 'handed_back', 'cancelled', 'waiting_budget'));

create table public.budget_asks (
  business_id    uuid        not null,
  id             uuid        not null,
  run_id         uuid        not null,
  reservation_id uuid        not null,
  lease_id       uuid        not null,
  decision_id    uuid        not null,
  ask_number     smallint    not null,
  kind           text        not null,
  ceiling_minor  bigint      not null,
  spent_minor    bigint      not null,
  currency       text        not null,
  raised_at      timestamptz not null default now(),
  constraint budget_asks_pkey primary key (id),
  constraint budget_asks_tenant_id_key unique (business_id, id),
  constraint budget_asks_run_number_key unique (business_id, run_id, ask_number),
  constraint budget_asks_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint budget_asks_run_fkey foreign key (business_id, run_id)
    references public.planned_runs (business_id, id),
  constraint budget_asks_reservation_fkey foreign key (business_id, reservation_id)
    references public.reservations (business_id, id),
  constraint budget_asks_lease_fkey foreign key (business_id, lease_id)
    references public.leases (business_id, id),
  constraint budget_asks_decision_fkey foreign key (business_id, decision_id)
    references public.gate_decisions (business_id, id),
  constraint budget_asks_number_bounded check (ask_number between 1 and 3),
  constraint budget_asks_third_is_consolidated
    check (kind = case when ask_number = 3 then 'consolidated' else 'stop' end),
  constraint budget_asks_ceiling_positive check (ceiling_minor > 0),
  constraint budget_asks_spent_within check (spent_minor between 0 and ceiling_minor),
  constraint budget_asks_currency_shape check (currency ~ '^[A-Z]{3}$')
);

create index budget_asks_business_idx on public.budget_asks (business_id);

alter table public.budget_asks enable row level security;
alter table public.budget_asks force row level security;

create policy tenancy_budget_asks on public.budget_asks
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_budget_asks on public.budget_asks
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.budget_asks to ops_astro_app;

-- The wait is entered from a claim and left by nothing. Invoker rights: the
-- caller's own row security applies, and it reads nothing.
create function public.planned_runs_budget_wait_holds() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if old.state = 'waiting_budget' and new.state is distinct from old.state then
    raise exception 'planned_runs: a run waiting for budget leaves the wait only by a person''s answer'
      using errcode = 'check_violation';
  end if;
  if new.state = 'waiting_budget' and old.state is distinct from new.state
     and old.state <> 'claimed' then
    raise exception 'planned_runs: only a claimed run stops at its ceiling'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.planned_runs_budget_wait_holds() from public;

create trigger planned_runs_budget_wait_holds
  before update of state on public.planned_runs
  for each row execute function public.planned_runs_budget_wait_holds();
