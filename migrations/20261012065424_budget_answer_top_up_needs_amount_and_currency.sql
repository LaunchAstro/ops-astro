-- SPDX-License-Identifier: AGPL-3.0-only
--
-- A top-up answer carries its amount and its currency (AW-05, 0088).
--
-- 0088's shape check compared a top-up's amount and currency without asking
-- that they be there, and a CHECK whose answer is unknown passes: a top-up
-- written with a NULL amount or currency was stored, and the run's wait then
-- let it out to `planned` on that answer. The command has always refused one,
-- so no row written through it holds a NULL; the check now says it too. No
-- function is added; the table's row security and grants are 0088's.

alter table public.budget_answers
  drop constraint budget_answers_shape,
  add constraint budget_answers_shape check (
    case kind
      when 'top_up' then amount_minor is not null and amount_minor > 0
                         and currency is not null and currency ~ '^[A-Z]{3}$'
      else amount_minor is null and currency is null and threshold_minor is null
           and second_person_id is null
    end
  );
