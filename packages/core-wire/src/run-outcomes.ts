// SPDX-License-Identifier: AGPL-3.0-only
//
// The run outcome contract (#1623 R1, "Run outcome contract, 18 October 2026"
// in `docs/current-decisions.md`). Every attempt that stops ends in one of
// seven named outcomes, with a typed end code from one closed union. The
// stop's own transaction writes it (`run_outcomes`, migration
// 20261018063000), and the code is never a suffix or free text: `outcomeOf`
// is the one place a code finds its outcome, and its `never` default makes a
// new code fail the type check until it has a row here and in the
// migration's per-outcome check.

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
  | 'SUBSCRIPTION_UNATTENDED'
  | 'SUBSCRIPTION_OTHER_TENANT'
  | 'SUBSCRIPTION_NOT_OWN_WORK'
  | 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK'
  | 'PROVIDER_NOTHING_HAPPENED'
  | 'LEASE_EXPIRED'
  | 'LEASE_NOT_OWNED'
  | 'LIABILITY_UNKNOWN'
  | 'OPEN_CALL_AT_STOP'
  | 'STILL_ANSWERING'
  | 'LOCAL_PLAN_LIMIT'
  | WorkerEndCode;

/** The outcome an end code belongs to. Total: a code with no row fails the type check. */
export function outcomeOf(code: EndCode): RunOutcome {
  switch (code) {
    case 'COMPLETED':
      return 'success';
    case 'BUDGET_UNAVAILABLE':
      return 'budget_wait';
    case 'CALL_LIMIT_REACHED':
      return 'call_limit';
    case 'LEASE_EXPIRED':
    case 'LEASE_NOT_OWNED':
      return 'lease_lost';
    case 'LIABILITY_UNKNOWN':
    case 'OPEN_CALL_AT_STOP':
    case 'ANSWER_LOST':
    case 'STILL_ANSWERING':
      return 'unknown_provider_outcome';
    case 'LOCAL_PLAN_LIMIT':
      return 'waiting_plan_allowance';
    case 'TASK_CANCELLED':
    case 'PLAN_SUPERSEDED':
    case 'DECISION_STALE':
    case 'AUTHORITY_LOST':
    case 'OPERATION_NOT_CATALOGUED':
    case 'EFFECT_NOT_RECONCILABLE':
    case 'LOCAL_MODEL_REQUIRED':
    case 'CLIENT_MODEL_USE_OFF':
    case 'SOURCE_UNREADABLE':
    case 'RATE_LIMITED':
    case 'COPY_NOT_REGISTERED':
    case 'CARRIAGE_UNAVAILABLE':
    case 'PROMPT_TOO_LARGE':
    case 'CUSTODY_NOT_ADMITTED':
    case 'SUBSCRIPTION_UNATTENDED':
    case 'SUBSCRIPTION_OTHER_TENANT':
    case 'SUBSCRIPTION_NOT_OWN_WORK':
    case 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK':
    case 'PROVIDER_NOTHING_HAPPENED':
    case 'TOOL_NOT_CATALOGUED':
    case 'TOOL_REFUSED':
    case 'TURN_MALFORMED':
    case 'TRACING_NOT_ALLOWED':
    case 'DEFINITION_MISMATCH':
    case 'SCOPE_NOT_GRANTED':
    case 'GATE_SHUT':
    case 'DELEGATION_EXCLUDES_OPERATION':
    case 'OPERATION_ID_REUSED':
      return 'cancelled';
    default:
      return unreachable(code);
  }
}

const unreachable = (code: never): never => {
  throw new Error(`end code ${String(code)} has no outcome`);
};

/** What the execution read shows of a run's latest stop (`task.execution`). */
export interface RunOutcomeView {
  readonly attemptId: string;
  readonly outcome: RunOutcome;
  readonly endCode: EndCode;
}
