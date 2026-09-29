-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0034 settlement at the observed cost (T2d). 0026 refused every `actual`
-- reservation "in this head", and said the head that settles real usage lifts
-- it in a migration somebody reviews. This is that head: observe prices the
-- worker's reported usage from the synthetic price book and settles the hold
-- to it (`core-runtime/src/observe.ts`). Nathan accepted lifting the backstop
-- on 27 September 2026 (package 2 item 7). 0026 stays on disk as approved.
--
-- One rule goes, one stays, three arrive:
--
-- - `reservations_first_head_no_actual` is dropped.
-- - `reservations_actual_positive` (0026) stays: an actual is a positive number.
-- - `reservations_actual_within_held`: a reservation settles to no more than it
--   held. A cost above the hold is not settled; the attempt is held as
--   `liability_unknown` at the maximum (O9).
-- - `attempts_actual_only_when_settled`: an attempt carries an actual exactly
--   when it is `settled`, the attempt's twin of 0013's reservation rule.
-- - `attempts_actual_positive`: that actual is positive; 0014 allowed zero.
--
-- No row is rewritten. Before this head nothing wrote an actual (hand-back
-- refused it, `ACTUAL_EXPENDITURE_UNSUPPORTED`, and still does), so every row
-- satisfies each new rule. Protected: budget invariants. Grants are unchanged.

alter table public.reservations drop constraint reservations_first_head_no_actual;

alter table public.reservations
  add constraint reservations_actual_within_held
    check (actual_minor is null or actual_minor <= held_minor);

alter table public.attempts
  add constraint attempts_actual_only_when_settled
    check ((state = 'settled') = (actual_minor is not null)),
  add constraint attempts_actual_positive check (actual_minor is null or actual_minor > 0);
