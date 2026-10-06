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
--               actual or abandoned; null for an end, and for a top-up
--               written before this, which the room counts as closed first.
-- No table, role, policy or grant is added: the column lives on the answer's
-- row, under its business's row security and the table's grants (0088), and
-- like the rest of the row it is written once, at the insert.

alter table public.budget_answers add column hold_state text;

alter table public.budget_answers add constraint budget_answers_hold_state_known check (
  hold_state is null or (kind = 'top_up' and hold_state in ('held', 'actual', 'abandoned'))
);
