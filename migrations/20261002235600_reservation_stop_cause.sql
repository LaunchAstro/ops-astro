-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 20261002235600 a hold settled at its spend records why it stopped (SL11-30). Since
-- SL11-29 the classifier settles a stopped hold `actual` at its calls' spend
-- (the sweep, a lineage cancel, lost authority, a hand-back, a drop) rather
-- than abandoning it at no cost. 0013's check tied a cause to `abandoned`
-- alone, so such a row could record no cause, and T5's "the cause and the
-- cause's identity on the row" held only for a hold with no spend.
--
-- The check now admits a cause on `actual` too. Every other state keeps its
-- rule: `abandoned` still needs a cause, and `held` and `quarantined` still
-- carry none. An `actual` settled at an observed outcome still records none.
-- Every row 0013's check admitted is admitted here, so no row is rewritten;
-- the constraint is added not valid and then validated. Protected: budget
-- invariants. No table, function, policy or grant changes.

alter table public.reservations drop constraint reservations_abandoned_has_cause;

alter table public.reservations
  add constraint reservations_abandoned_has_cause
  check (
    case state
      when 'abandoned' then classified_cause is not null
      when 'actual' then true
      else classified_cause is null
    end
  ) not valid;

alter table public.reservations validate constraint reservations_abandoned_has_cause;
