-- SPDX-License-Identifier: AGPL-3.0-only
--
-- An agent's name is read by everyone who reads a task it holds, so it holds
-- nothing a reader cannot see: no C0 or C1 control or DEL, no line or
-- paragraph separator, and no bidi mark, embedding, override or isolate, as
-- `agentNameOf` (`packages/core-records/src/authority/agents.ts`) refuses them.
-- 20261011115838 checked only trim and length, so a row written past the
-- command could carry one. Postgres text holds no NUL or lone surrogate, so the
-- class names the rest. The joiners emoji need stay.
--
-- A name written before this check that carries one loses those characters,
-- and a name left empty becomes "Agent", so the check holds for every row.
-- No function is added; the column sits on `actors`, whose row security is
-- already enabled, forced and keyed on the business.

update public.actors
   set display_name = coalesce(
         nullif(btrim(regexp_replace(display_name,
           '[\u0001-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]', '', 'g')), ''),
         'Agent')
 where display_name ~ '[\u0001-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]';

alter table public.actors
  drop constraint actors_display_name_shape,
  add constraint actors_display_name_shape check (
    display_name is null
    or (display_name = btrim(display_name) and length(display_name) between 1 and 60
        and display_name !~ '[\u0001-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]')
  );
