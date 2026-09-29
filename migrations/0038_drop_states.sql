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
-- progress and `reactivated` when the work is reserved again, and tells a
-- person with a `dropped` alert. A worker reports a provider or connection
-- drop by handing back `dropped`.
--
-- Constraint swaps only, as 0033's: no function is created and the gate
-- engine's tables are not touched. Protected: budget invariants.

alter table public.attempts add column drop_cause text;

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

alter table public.alerts drop constraint alerts_kind_known;
alter table public.alerts add constraint alerts_kind_known
  check (kind in ('settled', 'failed', 'cancelled', 'awaiting_person', 'dropped'));

alter table public.handback_reports drop constraint handback_reports_outcome_known;
alter table public.handback_reports add constraint handback_reports_outcome_known
  check (outcome in ('completed', 'failed', 'dropped'));
