-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0037 absence proved (T3d1). The reconciliation pass asks the operation
-- register whether an unknown step's effect happened. When it proves the
-- effect absent, the step resumes as a new attempt with its own hold, and the
-- old hold stays held, at its whole maximum, until a person records an outcome
-- or writes it off (O6): no machine path releases it.
--
-- 0019 allowed one active hold per version, so the replacement had nowhere to
-- go. `absence_proved_at` records the pass's answer on the old hold, in the
-- same transaction that fenced the old identity and reserved the replacement,
-- and the one-active-hold rule now counts every hold except one whose absence
-- was proved. Two concurrent working holds on a version are still refused.
-- The column is also why a second wake-up does nothing: a hold already
-- answered is never asked again.
--
-- A person who records that nothing happened releases the hold: the
-- reservation is abandoned under that recorded cause (0013 keeps a zero
-- actual off the row), and the attempt, which carries its dispatch marker, may
-- now end `abandoned` too, but only with the outcome `abandoned` a person
-- recorded. Every other marked attempt keeps 0033's owning states.
--
-- The old hold may later settle (a person's recorded outcome) or be written
-- off (T3c), so the check admits those states and no other. Protected: budget
-- invariants. No function is created. The gate engine's tables are not
-- touched.

alter table public.reservations add column absence_proved_at timestamptz;

alter table public.reservations add constraint reservations_absence_on_a_hold
  check (absence_proved_at is null or state in ('held', 'actual', 'abandoned'));

drop index public.reservations_one_active_per_version_idx;

create unique index reservations_one_active_per_version_idx
  on public.reservations (business_id, version_id)
  where state in ('held', 'quarantined') and absence_proved_at is null;

alter table public.attempts drop constraint attempts_marker_in_owning_state;
alter table public.attempts add constraint attempts_marker_in_owning_state
  check (
    state = 'quarantined'
    or (not dispatch_marker and not observed)
    or (dispatch_marker and state in ('dispatched', 'settled', 'liability_unknown'))
    or (dispatch_marker and state = 'abandoned' and outcome = 'abandoned')
  );
