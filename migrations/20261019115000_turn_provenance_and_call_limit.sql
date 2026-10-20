-- SPDX-License-Identifier: AGPL-3.0-only
--
-- #1623 R3: the turn's provenance and the attempt's call limit (design R4,
-- R7 and F3; `core-custody/src/broker-turn.ts`).
--
-- A settled turn's answer keeps only its digest, never its words: the sha256
-- of the canonical JSON of `{v, text, toolCalls}`, so a later turn that
-- carries the answer back is checked against it. Beside it, the source class
-- of the turn that made the answer, so an answer never becomes less strict on
-- a later turn. Calls from before this migration, and calls that are not
-- turns, keep both null, and a null digest never matches.
--
-- Each hold of a run attempt records its position among the attempt's calls
-- (`call_ordinal`, from 0, counted under the run lock the reserve holds) and
-- the attempt's call limit, the one its first hold recorded, so a
-- deployment's limit changed mid-attempt never raises it. Both are kept on
-- the call row the reserve already inserts, so the reserve takes no other
-- lock; the unique index is the backstop if two holds ever took one place.
-- A call of work that is no run attempt records neither, and has no limit.
--
-- The run outcome's per-outcome check gains the two turn codes, as
-- `outcomeOf` has them (`core-wire/src/run-outcomes.ts`).

alter table public.model_calls
  add column answer_digest text,
  add column answer_source text,
  add constraint model_calls_answer_digest_shape check (answer_digest ~ '^[0-9a-f]{64}$'),
  add constraint model_calls_answer_source_known check (
    answer_source in ('business_internal', 'client_row', 'client_person', 'guest', 'outside')),
  add column call_ordinal integer,
  add column call_limit integer,
  add constraint model_calls_answer_digest_with_source check (
    (answer_digest is null) = (answer_source is null)),
  add constraint model_calls_call_place check (
    (call_ordinal is null) = (call_limit is null)
    and (call_ordinal is null or (call_ordinal >= 0 and call_limit > 0)));

create unique index model_calls_one_call_per_place
  on public.model_calls (business_id, lease_id, call_ordinal)
  where call_ordinal is not null;

alter table public.run_outcomes
  drop constraint run_outcomes_end_code_of_outcome,
  add constraint run_outcomes_end_code_of_outcome check (
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
      'TURN_ORDINAL_STALE', 'PROVENANCE_UNBOUND',
      'SUBSCRIPTION_UNATTENDED', 'SUBSCRIPTION_OTHER_TENANT', 'SUBSCRIPTION_NOT_OWN_WORK',
      'SUBSCRIPTION_NOT_FOR_CLIENT_WORK', 'SUBSCRIPTION_NOT_OWNER_STARTED',
      'PROVIDER_NOTHING_HAPPENED',
      'TOOL_NOT_CATALOGUED', 'TOOL_REFUSED', 'TURN_MALFORMED', 'TRACING_NOT_ALLOWED',
      'DEFINITION_MISMATCH', 'SCOPE_NOT_GRANTED', 'GATE_SHUT',
      'DELEGATION_EXCLUDES_OPERATION', 'OPERATION_ID_REUSED')));
