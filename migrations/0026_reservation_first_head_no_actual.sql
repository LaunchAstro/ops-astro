-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0026 a reservation is never `actual` in the first head, and an actual amount
-- is never zero or negative.
--
-- 0013 says a reservation's first-head terminal state is `abandoned`, never a
-- zero `actual`, but its checks do not hold that. `reservations_actual_only_when_actual`
-- refuses a number on a row that is not `actual`, and nothing refuses an
-- `actual` row, and `actual_minor` has no sign check. So an update by the
-- application role from `held` to `actual` with 0, or with a negative number,
-- commits (final review round 1, R1-RUNTIME-63). The handback refuses any
-- reported actual with `ACTUAL_EXPENDITURE_UNSUPPORTED` before its first write
-- (`core-runtime/src/handback.ts`); the code refuses first so the caller gets
-- a reason, and this refuses second so a writer that got around the code gets
-- nothing. Nathan approved it on 24 September 2026.
--
-- Two rules. `reservations_first_head_no_actual` mirrors
-- `planned_steps_undispatched` (0010): this head spends nothing, so the state
-- that records spending is refused, and the head that settles real usage lifts
-- it in a migration somebody reviews. `reservations_actual_positive` outlives
-- that head: an actual amount, once allowed, is a positive number.
--
-- Additive, and validated as it is added. A fresh database and an upgraded one
-- hold the same rules over the same rows: an installation already holding an
-- `actual` reservation fails this migration, naming the constraint, and stays
-- at 0025 with its rows untouched. Nothing is rewritten to make it pass.
-- Grants are unchanged.

alter table public.reservations
  add constraint reservations_first_head_no_actual check (state <> 'actual');

alter table public.reservations
  add constraint reservations_actual_positive check (actual_minor is null or actual_minor > 0);
