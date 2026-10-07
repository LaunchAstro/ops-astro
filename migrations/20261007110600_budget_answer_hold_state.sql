-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 20261007110600 a top-up records the state of the stopped hold it answered (AW-05, #988).
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
-- Every top-up already there is recorded `held` (the owner's money fix b,
-- #988). No earlier row says which state its hold was in, and a guess from
-- another row's stamp, step or amount can read a held top-up as closed (Sol
-- SC2: a reconciled replacement made in the same microsecond), counting the
-- hold once and letting a replacement pass the approved ceiling. Read as held,
-- a hold closed first counts its calls twice, so the version has less room
-- than it did and a replacement stops at its budget and asks: work is refused
-- rather than overspent, and a person's top-up answers it. Only rows still
-- without a state are written, so a second run changes nothing.

alter table public.budget_answers add column if not exists hold_state text;

update public.budget_answers
   set hold_state = 'held'
 where kind = 'top_up' and hold_state is null;

alter table public.budget_answers drop constraint if exists budget_answers_hold_state_known;

alter table public.budget_answers add constraint budget_answers_hold_state_known check (
  case kind
    when 'top_up' then hold_state is not null and hold_state in ('held', 'actual', 'abandoned')
    else hold_state is null
  end
);
