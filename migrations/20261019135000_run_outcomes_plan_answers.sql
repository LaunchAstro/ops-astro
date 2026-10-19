-- SPDX-License-Identifier: AGPL-3.0-only
--
-- #1625 R9: the owner's ChatGPT plan's answers end a run in their own codes
-- (`outcomeOf` in core-wire/src/run-outcomes.ts). The usage allowance is
-- `waiting_plan_allowance`, beside LOCAL_PLAN_LIMIT; the plan unavailable is
-- the eighth outcome, `plan_unavailable` (the owner's ruling, register 107:
-- no retry, a person restarts); signing in again is `cancelled` with its own
-- code. Both checks are widened only: every row they held before still holds,
-- the turn codes 20261019115000 added included.

alter table public.run_outcomes
  drop constraint run_outcomes_outcome_known,
  add constraint run_outcomes_outcome_known check (outcome in (
    'success', 'budget_wait', 'call_limit', 'cancelled', 'lease_lost',
    'unknown_provider_outcome', 'waiting_plan_allowance', 'plan_unavailable'));

alter table public.run_outcomes
  drop constraint run_outcomes_end_code_of_outcome,
  add constraint run_outcomes_end_code_of_outcome check (
    (outcome = 'success' and end_code = 'COMPLETED')
    or (outcome = 'budget_wait' and end_code = 'BUDGET_UNAVAILABLE')
    or (outcome = 'call_limit' and end_code = 'CALL_LIMIT_REACHED')
    or (outcome = 'lease_lost' and end_code in ('LEASE_EXPIRED', 'LEASE_NOT_OWNED'))
    or (outcome = 'unknown_provider_outcome'
        and end_code in ('LIABILITY_UNKNOWN', 'OPEN_CALL_AT_STOP', 'ANSWER_LOST', 'STILL_ANSWERING'))
    or (outcome = 'waiting_plan_allowance'
        and end_code in ('LOCAL_PLAN_LIMIT', 'SUBSCRIPTION_PLAN_ALLOWANCE'))
    or (outcome = 'plan_unavailable' and end_code = 'SUBSCRIPTION_PLAN_UNAVAILABLE')
    or (outcome = 'cancelled' and end_code in (
      'TASK_CANCELLED', 'PLAN_SUPERSEDED', 'DECISION_STALE', 'AUTHORITY_LOST',
      'OPERATION_NOT_CATALOGUED', 'EFFECT_NOT_RECONCILABLE', 'LOCAL_MODEL_REQUIRED',
      'CLIENT_MODEL_USE_OFF', 'SOURCE_UNREADABLE', 'RATE_LIMITED', 'COPY_NOT_REGISTERED',
      'CARRIAGE_UNAVAILABLE', 'PROMPT_TOO_LARGE', 'CUSTODY_NOT_ADMITTED',
      'TURN_ORDINAL_STALE', 'PROVENANCE_UNBOUND',
      'SUBSCRIPTION_UNATTENDED', 'SUBSCRIPTION_OTHER_TENANT', 'SUBSCRIPTION_NOT_OWN_WORK',
      'SUBSCRIPTION_NOT_FOR_CLIENT_WORK', 'SUBSCRIPTION_NOT_OWNER_STARTED',
      'SUBSCRIPTION_SIGN_IN_NEEDED',
      'PROVIDER_NOTHING_HAPPENED',
      'TOOL_NOT_CATALOGUED', 'TOOL_REFUSED', 'TURN_MALFORMED', 'TRACING_NOT_ALLOWED',
      'DEFINITION_MISMATCH', 'SCOPE_NOT_GRANTED', 'GATE_SHUT',
      'DELEGATION_EXCLUDES_OPERATION', 'OPERATION_ID_REUSED')));
