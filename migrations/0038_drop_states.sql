-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0038 drop states (T3e1). A run that stops because something failed under it
-- is a drop, never a person's cancellation, and each drop keeps its cause so
-- the root cause stays diagnosable (docs/decisions/execution.md, C117 to C124):
-- the provider did not answer, the connection to it was lost, or our worker
-- was lost. The fault each names (the provider's, the network's, ours) is
-- read from the cause, never stored twice.
--
-- An unmarked attempt that dropped ends `dropped`, its hold released by the
-- classifier as before; a marked one keeps `liability_unknown` and its whole
-- hold, carrying the cause beside it, for the reconciliation pass (T3d1).
-- Either way the cause is written once. A drop appends `dropped` to the run's
-- progress and `reactivated` when the work is reserved again; a person is
-- told by the outage report it joins (T3e2, 0039), not an alert per run. A
-- worker reports a provider or connection drop by handing back `dropped`.
--
-- Constraint swaps only, as 0033's: no function is created and the gate
-- engine's tables are not touched. Protected: budget invariants.

alter table public.attempts add column drop_cause text;

-- Sol review 3 on #154: the worker records that it is starting its provider,
-- once the step is marked and before the call, so a worker lost after it is
-- known to have reached a provider that may have acted. Written once, only on
-- a marked attempt.
alter table public.attempts add column provider_started_at timestamptz;

alter table public.attempts add constraint attempts_provider_started_marked
  check (provider_started_at is null or dispatch_marker);

alter table public.attempts add constraint attempts_drop_cause_known
  check (drop_cause is null
         or drop_cause in ('provider_unavailable', 'connection_lost', 'worker_lost'));

alter table public.attempts drop constraint attempts_state_known;
alter table public.attempts add constraint attempts_state_known
  check (state in ('reserved', 'dispatched', 'handed_back', 'abandoned', 'quarantined',
                   'settled', 'liability_unknown', 'dropped'));

alter table public.attempts add constraint attempts_dropped_has_cause
  check (state <> 'dropped' or drop_cause is not null);

alter table public.run_events drop constraint run_events_kind_known;
alter table public.run_events add constraint run_events_kind_known
  check (kind in ('claimed', 'handed_back', 'dropped', 'reactivated'));

alter table public.handback_reports drop constraint handback_reports_outcome_known;
alter table public.handback_reports add constraint handback_reports_outcome_known
  check (outcome in ('completed', 'failed', 'dropped'));
