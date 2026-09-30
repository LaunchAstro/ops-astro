-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0033 the dispatch mark (T2c1). 0010 kept `planned_steps.dispatched_at` null
-- by a check and 0014 kept a marked attempt quarantined, "until a later unit
-- activates dispatch". This is that unit, and it is three constraint changes
-- (spike RN-05):
--
-- - The attempt's known states admit `settled` and `liability_unknown`, which
--   settlement (T2d) and the sweeper (T3b) write.
-- - A marker is admitted only in its owning states. `dispatched` already means
--   "picked up under a lease"; the dispatch marker inside it is the effect
--   mark. Handing back a marked attempt is still refused, so handback leaves a
--   marked attempt to the classifier, which quarantines it with its hold.
-- - A step rule reads another table, so it cannot be a check. A dispatched
--   step names its own attempt, and a composite foreign key onto a new unique
--   key on attempts holds that attempt to carrying the marker. The key is not
--   deferrable, so dispatch raises the marker before it writes the step.
--
-- No row is rewritten: the columns are nullable with no default, and every
-- existing row satisfies each new rule. Dropping the old checks takes an
-- exclusive lock on both tables inside the runner's one transaction, so a
-- plain swap is right and NOT VALID then VALIDATE would buy nothing; stop the
-- API for an upgrade with live traffic. No function is created. Protected:
-- gate-engine and budget invariants.

alter table public.attempts drop constraint attempts_state_known;
alter table public.attempts add constraint attempts_state_known
  check (state in ('reserved', 'dispatched', 'handed_back', 'abandoned', 'quarantined',
                   'settled', 'liability_unknown'));

alter table public.attempts drop constraint attempts_marked_is_quarantined;
alter table public.attempts add constraint attempts_marker_in_owning_state
  check (
    state = 'quarantined'
    or (not dispatch_marker and not observed)
    or (dispatch_marker and state in ('dispatched', 'settled', 'liability_unknown'))
  );

alter table public.attempts add constraint attempts_step_marker_key
  unique (business_id, id, step_id, dispatch_marker);

alter table public.planned_steps drop constraint planned_steps_undispatched;
alter table public.planned_steps
  add column dispatch_attempt_id uuid,
  add column dispatch_marked boolean;
alter table public.planned_steps
  add constraint planned_steps_dispatch_named check (
    (dispatched_at is null and dispatch_attempt_id is null and dispatch_marked is null)
    or (dispatched_at is not null and dispatch_attempt_id is not null and dispatch_marked)
  ),
  add constraint planned_steps_dispatch_attempt_fkey
    foreign key (business_id, dispatch_attempt_id, id, dispatch_marked)
    references public.attempts (business_id, id, step_id, dispatch_marker);

-- The worker holds nothing, as 0008 left it (spike RN-04); stated again for
-- the two tables this migration changes. The default-privileges revoke is the
-- owner's decision (owner line 62) and is not made here.
revoke all on public.attempts, public.planned_steps from ops_astro_worker;
