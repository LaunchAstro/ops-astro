// SPDX-License-Identifier: AGPL-3.0-only
//
// The run outcome contract (#1623 R1, "Run outcome contract, 18 October 2026" in
// `docs/current-decisions.md`). Every attempt that stops ends in one of seven named outcomes, with
// a typed end code from one closed union. The stop's own transaction writes it (`run_outcomes`,
// migration 20261019105500), and the code is never a suffix or free text: `outcomeOf` is the one
// place a code finds its outcome, and its table is keyed by every code, so a new one fails the type
// check until it has a row here and in the migration's per-outcome check.

/** The seven outcomes an attempt can end in. */
export const RUN_OUTCOMES = [
  'success',
  'budget_wait',
  'call_limit',
  'cancelled',
  'lease_lost',
  'unknown_provider_outcome',
  'waiting_plan_allowance',
] as const;

export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** The codes the worker may end its own run with (`run.end`): what only it can see. */
export const WORKER_END_CODES = [
  'CALL_LIMIT_REACHED',
  'TOOL_NOT_CATALOGUED',
  'TOOL_REFUSED',
  'TURN_MALFORMED',
  'TRACING_NOT_ALLOWED',
  'DEFINITION_MISMATCH',
  'ANSWER_LOST',
  // The door's refusals of `model.call` or `task.read` while the delegation is live.
  'SCOPE_NOT_GRANTED',
  'GATE_SHUT',
  'DELEGATION_EXCLUDES_OPERATION',
  'OPERATION_ID_REUSED',
] as const;

export type WorkerEndCode = (typeof WORKER_END_CODES)[number];

export const isWorkerEndCode = (code: unknown): code is WorkerEndCode =>
  (WORKER_END_CODES as readonly unknown[]).includes(code);

/** Every end code, by the outcome it belongs to. */
export type EndCode =
  | 'COMPLETED'
  | 'BUDGET_UNAVAILABLE'
  | 'CALL_LIMIT_REACHED'
  // A person's stop, or authority lost under the work.
  | 'TASK_CANCELLED'
  | 'PLAN_SUPERSEDED'
  | 'DECISION_STALE'
  | 'AUTHORITY_LOST'
  // The broker's definitive refusals, verbatim (`core-custody`, `BrokerRefusal`).
  | 'OPERATION_NOT_CATALOGUED'
  | 'EFFECT_NOT_RECONCILABLE'
  | 'LOCAL_MODEL_REQUIRED'
  | 'CLIENT_MODEL_USE_OFF'
  | 'SOURCE_UNREADABLE'
  | 'RATE_LIMITED'
  | 'COPY_NOT_REGISTERED'
  | 'CARRIAGE_UNAVAILABLE'
  | 'PROMPT_TOO_LARGE'
  | 'CUSTODY_NOT_ADMITTED'
  // The turn's own (#1623 R3): an ordinal not the attempt's count, a part the broker cannot bind.
  | 'TURN_ORDINAL_STALE'
  | 'PROVENANCE_UNBOUND'
  | 'SUBSCRIPTION_UNATTENDED'
  | 'SUBSCRIPTION_OTHER_TENANT'
  | 'SUBSCRIPTION_NOT_OWN_WORK'
  | 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK'
  | 'SUBSCRIPTION_NOT_OWNER_STARTED'
  | 'PROVIDER_NOTHING_HAPPENED'
  | 'LEASE_EXPIRED'
  | 'LEASE_NOT_OWNED'
  | 'LIABILITY_UNKNOWN'
  | 'OPEN_CALL_AT_STOP'
  | 'STILL_ANSWERING'
  | 'LOCAL_PLAN_LIMIT'
  | WorkerEndCode;

/** Each end code's outcome. Keyed by every code, so one with no row fails the type check. */
const OUTCOME_OF: { readonly [Code in EndCode]: RunOutcome } = {
  COMPLETED: 'success',
  BUDGET_UNAVAILABLE: 'budget_wait',
  CALL_LIMIT_REACHED: 'call_limit',
  LEASE_EXPIRED: 'lease_lost',
  LEASE_NOT_OWNED: 'lease_lost',
  LIABILITY_UNKNOWN: 'unknown_provider_outcome',
  OPEN_CALL_AT_STOP: 'unknown_provider_outcome',
  ANSWER_LOST: 'unknown_provider_outcome',
  STILL_ANSWERING: 'unknown_provider_outcome',
  LOCAL_PLAN_LIMIT: 'waiting_plan_allowance',
  TASK_CANCELLED: 'cancelled',
  PLAN_SUPERSEDED: 'cancelled',
  DECISION_STALE: 'cancelled',
  AUTHORITY_LOST: 'cancelled',
  OPERATION_NOT_CATALOGUED: 'cancelled',
  EFFECT_NOT_RECONCILABLE: 'cancelled',
  LOCAL_MODEL_REQUIRED: 'cancelled',
  CLIENT_MODEL_USE_OFF: 'cancelled',
  SOURCE_UNREADABLE: 'cancelled',
  RATE_LIMITED: 'cancelled',
  COPY_NOT_REGISTERED: 'cancelled',
  CARRIAGE_UNAVAILABLE: 'cancelled',
  PROMPT_TOO_LARGE: 'cancelled',
  CUSTODY_NOT_ADMITTED: 'cancelled',
  TURN_ORDINAL_STALE: 'cancelled',
  PROVENANCE_UNBOUND: 'cancelled',
  SUBSCRIPTION_UNATTENDED: 'cancelled',
  SUBSCRIPTION_OTHER_TENANT: 'cancelled',
  SUBSCRIPTION_NOT_OWN_WORK: 'cancelled',
  SUBSCRIPTION_NOT_FOR_CLIENT_WORK: 'cancelled',
  SUBSCRIPTION_NOT_OWNER_STARTED: 'cancelled',
  PROVIDER_NOTHING_HAPPENED: 'cancelled',
  TOOL_NOT_CATALOGUED: 'cancelled',
  TOOL_REFUSED: 'cancelled',
  TURN_MALFORMED: 'cancelled',
  TRACING_NOT_ALLOWED: 'cancelled',
  DEFINITION_MISMATCH: 'cancelled',
  SCOPE_NOT_GRANTED: 'cancelled',
  GATE_SHUT: 'cancelled',
  DELEGATION_EXCLUDES_OPERATION: 'cancelled',
  OPERATION_ID_REUSED: 'cancelled',
};

/** The outcome an end code belongs to: the one place a code finds it. */
export const outcomeOf = (code: EndCode): RunOutcome => OUTCOME_OF[code];

/** What the execution read shows of a run's latest stop (`task.execution`). */
export interface RunOutcomeView {
  readonly attemptId: string;
  readonly outcome: RunOutcome;
  readonly endCode: EndCode;
}
