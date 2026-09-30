-- SPDX-License-Identifier: AGPL-3.0-only
--
-- AW-05: the answers at the budget stop. A run waiting for budget
-- (0193) leaves the wait only by a person's answer to its latest ask
-- (`core-runtime/src/budget-answer.ts`):
--
--   budget_approvals  one row per person approving a top-up of one ask: the
--                     amount and currency they approved. Above the
--                     business's four-eyes threshold the first approval
--                     applies nothing, and a second, distinct person
--                     approving the same top-up completes it. A person
--                     approves an ask once.
--   budget_answers    one row per answered ask, the answer itself: a
--                     `top_up` (amount, currency, the threshold read when it
--                     was decided, and the one or two people who approved
--                     it) or an `end` (the one click, by one person). An ask
--                     is answered once.
--
-- The wait's trigger is widened: a waiting run may become `planned` only when
-- its latest ask has a top-up answer, and `cancelled` only when it has an end.
-- Nothing else takes it out of the wait.
--
-- Both tables are append-only: the application group may insert and read,
-- and never update or delete. The worker and broker roles hold nothing.
-- Numbered after main's 0041 at the rebase; the batch integration may number it again.

create table public.budget_approvals (
  business_id  uuid        not null,
  id           uuid        not null,
  ask_id       uuid        not null,
  run_id       uuid        not null,
  person_id    uuid        not null,
  actor_id     uuid        not null,
  amount_minor bigint      not null,
  currency     text        not null,
  approved_at  timestamptz not null default now(),
  constraint budget_approvals_pkey primary key (id),
  constraint budget_approvals_tenant_id_key unique (business_id, id),
  constraint budget_approvals_once_key unique (business_id, ask_id, person_id),
  constraint budget_approvals_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint budget_approvals_ask_fkey foreign key (business_id, ask_id)
    references public.budget_asks (business_id, id),
  constraint budget_approvals_run_fkey foreign key (business_id, run_id)
    references public.planned_runs (business_id, id),
  constraint budget_approvals_person_fkey foreign key (business_id, person_id)
    references public.people (business_id, id),
  constraint budget_approvals_actor_fkey foreign key (business_id, actor_id)
    references public.actors (business_id, id),
  constraint budget_approvals_amount_positive check (amount_minor > 0),
  constraint budget_approvals_currency_shape check (currency ~ '^[A-Z]{3}$')
);

create index budget_approvals_business_idx on public.budget_approvals (business_id);
create index budget_approvals_run_idx on public.budget_approvals (business_id, run_id);

create table public.budget_answers (
  business_id      uuid        not null,
  id               uuid        not null,
  ask_id           uuid        not null,
  run_id           uuid        not null,
  kind             text        not null,
  amount_minor     bigint,
  currency         text,
  threshold_minor  bigint,
  first_person_id  uuid        not null,
  second_person_id uuid,
  answered_at      timestamptz not null default now(),
  constraint budget_answers_pkey primary key (id),
  constraint budget_answers_tenant_id_key unique (business_id, id),
  constraint budget_answers_once_key unique (business_id, ask_id),
  constraint budget_answers_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint budget_answers_ask_fkey foreign key (business_id, ask_id)
    references public.budget_asks (business_id, id),
  constraint budget_answers_run_fkey foreign key (business_id, run_id)
    references public.planned_runs (business_id, id),
  constraint budget_answers_first_fkey foreign key (business_id, first_person_id)
    references public.people (business_id, id),
  constraint budget_answers_second_fkey foreign key (business_id, second_person_id)
    references public.people (business_id, id),
  constraint budget_answers_kind_known check (kind in ('top_up', 'end')),
  constraint budget_answers_shape check (
    case kind
      when 'top_up' then amount_minor > 0 and currency ~ '^[A-Z]{3}$'
      else amount_minor is null and currency is null and threshold_minor is null
           and second_person_id is null
    end
  ),
  constraint budget_answers_threshold_not_negative
    check (threshold_minor is null or threshold_minor >= 0),
  constraint budget_answers_four_eyes_distinct
    check (second_person_id is null or second_person_id <> first_person_id)
);

create index budget_answers_business_idx on public.budget_answers (business_id);
create index budget_answers_run_idx on public.budget_answers (business_id, run_id);

alter table public.budget_approvals enable row level security;
alter table public.budget_approvals force row level security;
alter table public.budget_answers enable row level security;
alter table public.budget_answers force row level security;

create policy tenancy_budget_approvals on public.budget_approvals
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_budget_approvals on public.budget_approvals
  as permissive
  for all
  using (true)
  with check (true);

create policy tenancy_budget_answers on public.budget_answers
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_budget_answers on public.budget_answers
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.budget_approvals to ops_astro_app;
grant select, insert on public.budget_answers to ops_astro_app;

-- The wait is entered from a claim and left only by an answer to the run's
-- latest ask: a top-up sends it back to `planned` for a fresh pickup, an end
-- to `cancelled`. Invoker rights: the caller's own row security applies, so
-- only an answer in the caller's business opens the run.
create or replace function public.planned_runs_budget_wait_holds() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if old.state = 'waiting_budget' and new.state is distinct from old.state then
    if not exists (
      select 1
        from public.budget_answers a
       where a.business_id = new.business_id
         and a.run_id = new.id
         and a.kind = case new.state when 'planned' then 'top_up'
                                     when 'cancelled' then 'end' end
         and a.ask_id = (select k.id from public.budget_asks k
                          where k.business_id = new.business_id and k.run_id = new.id
                          order by k.ask_number desc limit 1)
    ) then
      raise exception 'planned_runs: a run waiting for budget leaves the wait only by a person''s answer'
        using errcode = 'check_violation';
    end if;
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
