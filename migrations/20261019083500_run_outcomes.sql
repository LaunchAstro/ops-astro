-- SPDX-License-Identifier: AGPL-3.0-only
--
-- #1623 R1: the run outcome contract ("Run outcome contract, 18 October
-- 2026", docs/current-decisions.md). Each attempt that stops ends in one
-- named outcome with a typed end code, written by the transaction that
-- stopped it (`core-custody/src/broker-stop.ts`). The first writer wins by
-- the primary key; the row is an observation of the stop and never changes:
-- the application may read and insert it, and no role but the owner may
-- update, delete or truncate it.
--
-- The codes per outcome are `outcomeOf`'s rows (`core-wire/src/run-outcomes.ts`).
-- `stop_cause` is the code a stop would have written when an open call made
-- the row unknown instead, so it is set only on `unknown_provider_outcome`.

-- The outcome's attempt is an attempt of the outcome's run.
alter table public.attempts
  add constraint attempts_run_key unique (business_id, id, run_id);

create table public.run_outcomes (
  business_id     uuid        not null,
  attempt_id      uuid        not null,
  planned_run_id  uuid        not null,
  outcome         text        not null,
  end_code        text        not null,
  stop_cause      text,
  agent_version   text,
  recorded_at     timestamptz not null default clock_timestamp(),
  -- The lease holder whose work the stop ended, from the lease, never an operand.
  recorded_by     uuid        not null,
  constraint run_outcomes_pkey primary key (business_id, attempt_id),
  constraint run_outcomes_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint run_outcomes_attempt_fkey foreign key (business_id, attempt_id)
    references public.attempts (business_id, id),
  constraint run_outcomes_run_fkey foreign key (business_id, planned_run_id)
    references public.planned_runs (business_id, id),
  constraint run_outcomes_attempt_run_fkey foreign key (business_id, attempt_id, planned_run_id)
    references public.attempts (business_id, id, run_id),
  constraint run_outcomes_recorded_by_fkey foreign key (business_id, recorded_by)
    references public.actors (business_id, id),
  constraint run_outcomes_outcome_known check (outcome in (
    'success', 'budget_wait', 'call_limit', 'cancelled', 'lease_lost',
    'unknown_provider_outcome', 'waiting_plan_allowance')),
  constraint run_outcomes_end_code_of_outcome check (
    (outcome = 'success' and end_code = 'COMPLETED')
    or (outcome = 'budget_wait' and end_code = 'BUDGET_UNAVAILABLE')
    or (outcome = 'call_limit' and end_code = 'CALL_LIMIT_REACHED')
    or (outcome = 'lease_lost' and end_code in ('LEASE_EXPIRED', 'LEASE_NOT_OWNED'))
    or (outcome = 'unknown_provider_outcome'
        and end_code in ('LIABILITY_UNKNOWN', 'OPEN_CALL_AT_STOP', 'ANSWER_LOST', 'STILL_ANSWERING'))
    or (outcome = 'waiting_plan_allowance' and end_code = 'LOCAL_PLAN_LIMIT')
    or (outcome = 'cancelled' and end_code in (
      'TASK_CANCELLED', 'PLAN_SUPERSEDED', 'DECISION_STALE', 'AUTHORITY_LOST',
      'OPERATION_NOT_CATALOGUED', 'EFFECT_NOT_RECONCILABLE', 'LOCAL_MODEL_REQUIRED',
      'CLIENT_MODEL_USE_OFF', 'SOURCE_UNREADABLE', 'RATE_LIMITED', 'COPY_NOT_REGISTERED',
      'CARRIAGE_UNAVAILABLE', 'PROMPT_TOO_LARGE', 'CUSTODY_NOT_ADMITTED',
      'SUBSCRIPTION_UNATTENDED', 'SUBSCRIPTION_OTHER_TENANT', 'SUBSCRIPTION_NOT_OWN_WORK',
      'SUBSCRIPTION_NOT_FOR_CLIENT_WORK', 'SUBSCRIPTION_NOT_OWNER_STARTED',
      'PROVIDER_NOTHING_HAPPENED',
      'TOOL_NOT_CATALOGUED', 'TOOL_REFUSED', 'TURN_MALFORMED', 'TRACING_NOT_ALLOWED',
      'DEFINITION_MISMATCH', 'SCOPE_NOT_GRANTED', 'GATE_SHUT',
      'DELEGATION_EXCLUDES_OPERATION', 'OPERATION_ID_REUSED'))),
  -- The intended cause beside an open call is any code that is not itself unknown.
  constraint run_outcomes_stop_cause_on_unknown check (
    stop_cause is null
    or (outcome = 'unknown_provider_outcome'
        and stop_cause ~ '^[A-Z][A-Z_]*$'
        and stop_cause not in ('LIABILITY_UNKNOWN', 'OPEN_CALL_AT_STOP', 'ANSWER_LOST',
                               'STILL_ANSWERING', 'COMPLETED')))
);

create index run_outcomes_run_idx on public.run_outcomes (business_id, planned_run_id);

alter table public.run_outcomes enable row level security;
alter table public.run_outcomes force row level security;

create policy tenancy_run_outcomes on public.run_outcomes
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_run_outcomes on public.run_outcomes
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.run_outcomes to ops_astro_app;
