// SPDX-License-Identifier: AGPL-3.0-only
//
// What `model.call`, `run.end` and `definition.read` do to data, entries of `COMMAND_EFFECTS`
// (data-effects.ts; `model.call` moved whole for the line cap).

import { business, client, writing, type DataEffects } from './data-effects-types.ts';

/** What any stop writes (#1623 R1): its attempt's outcome, and its unsent calls released. */
export const STOP = ['model_calls', 'run_outcomes'] as const;

// #1623 R1: the worker's stop records its attempt's outcome, releases its unsent holds and retires
// its work, the lease released and its delegation revoked.
export const RUN_END_EFFECTS: DataEffects = writing([
  ...client('leases', 'model_calls', 'run_outcomes'),
  ...business('delegations'),
]);

// #1904: a pinned read's ledger row, on the run, and its audit copy, kept once per business.
export const DEFINITION_READ_EFFECTS: DataEffects = writing([
  ...client('bootstrap_reads'),
  ...business('bootstrap_bytes'),
]);

// AW-01: the broker's hold on the lease's run and its prompt copy's registration. At the approved
// ceiling the refusal commits the stop instead (AW-05): the ask, the lease released, the
// delegation retired, the run waiting; past the run's last ask, the run ended and a person told
// on the task (`alerts`). The provider call goes through the credential broker; a client's task
// never reaches a route (C60), so it is the business's own.
// Every stop records its attempt's outcome, and a provider drop at settlement records T3e1's drop
// (#1623 R1): the attempt's cause, the hold classified, the run's progress, the work back.
export const MODEL_CALL_EFFECTS: DataEffects = writing(
  [
    ...client('model_calls', 'alerts', 'budget_asks', 'leases', 'planned_runs'),
    ...client('attempts', 'reservations', 'run_events', 'run_outcomes', 'task_envelopes'),
    ...business('copy_registrations', 'delegations'),
  ],
  [{ provider: 'model', forClient: false }],
);
