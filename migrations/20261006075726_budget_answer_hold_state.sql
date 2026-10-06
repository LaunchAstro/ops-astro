-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 20261006075726 a top-up records the state of the stopped hold it answered (AW-05, #988).
--
-- A top-up answers a stop raised on a hold that was still held, or on one
-- already closed: settled at its calls' spend (`actual`) or ended unspent
-- (`abandoned`) (`core-runtime/src/budget-answer.ts`). The version room
-- (`versionRoom`, `core-runtime/src/pickup.ts`) counts a closed hold the two
-- differ on. A held hold's top-up moved its calls' spend to the envelope, so a
-- later close charges only what it adds: the hold counts at its actual plus its
-- calls. A hold closed first already has its calls in its actual: it counts
-- once, at the greater. No column told them apart, so this one records it:
--   hold_state  the stopped hold's state when its top-up answered: held,
--               actual or abandoned on every top-up; null on an end.
-- No table, role, policy or grant is added: the column lives on the answer's
-- row, under its business's row security and the table's grants (0088), and
-- like the rest of the row it is written once, at the insert.
--
-- Every top-up already there is given its state here, so no top-up is left
-- without one. A top-up on a closed hold held the step afresh in its own
-- transaction (`holdTopUp`): that hold's attempt is stamped `now()`, the
-- transaction's start, as the answer's `answered_at` is, so the two stamps
-- are equal, and it is for the stopped hold's step at the top-up's amount
-- (both fixed once written), so another transaction on the run that started
-- in the same microsecond is not taken for it. A closed hold never changes
-- state again, so its state now is its state then. A top-up on a held hold
-- made no hold: it found the hold held. A stopped hold in any other state
-- fails the check, and the upgrade with it.

alter table public.budget_answers add column hold_state text;

update public.budget_answers a
   set hold_state = case when exists (
                      select 1 from public.attempts t
                       where t.business_id = a.business_id and t.run_id = a.run_id
                         and t.reservation_id <> k.reservation_id
                         and t.created_at = a.answered_at
                         and t.estimated_minor = a.amount_minor
                         and t.step_id in (select s.step_id from public.attempts s
                                            where s.business_id = k.business_id
                                              and s.reservation_id = k.reservation_id))
                    then r.state else 'held' end
  from public.budget_asks k, public.reservations r
 where a.kind = 'top_up'
   and k.business_id = a.business_id and k.id = a.ask_id
   and r.business_id = k.business_id and r.id = k.reservation_id;

alter table public.budget_answers add constraint budget_answers_hold_state_known check (
  case kind
    when 'top_up' then hold_state is not null and hold_state in ('held', 'actual', 'abandoned')
    else hold_state is null
  end
);
