-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0020 a revision on a business setting, so two administrators writing at once
-- are told apart.
--
-- `business_settings` (0009) carried no revision, so there was nothing for a
-- caller to write against: the two settings commands took no expected
-- revision, and two people editing the same row from two browser tabs both
-- wrote, the second silently replacing the first with a value chosen before
-- the first existed. That is the lost update `records.revision` (0005) was
-- given to close, and a setting that decides whether a second approver is
-- needed is the last row in the schema that should be missing it.
--
-- The column is what the mechanism is. `integer` and not `records`'s `bigint`
-- because a setting is written by an administrator at human frequency, not by
-- a machine loop over a work item, and int4 holds two billion writes of one
-- setting; the two are never compared, so there is no arithmetic that has to
-- agree between them.
--
-- `default 1` is what upgrades an installation that already has settings: an
-- existing row is at the revision it would have been given had this column
-- always been here, so a reader that has just learnt to ask never sees a null
-- and never has to decide what one means. `not null` for the same reason the
-- records column is -- a revision nobody set is a comparison nobody can make.
--
-- **No trigger, deliberately.** 0005 bumps `records.revision` from a trigger
-- because every writer of a record goes through the slot recomputation the
-- same trigger does, and a second writer that forgot would be silently
-- correct. Nothing like that is true here: the increment belongs to the one
-- statement the settings module owns, which reads the row `for update`,
-- compares the revision it was handed, and then writes the value and the
-- revision together (`returning revision`). The tenancy wrapper needs nothing
-- added -- row security already confines the statement to one business, and
-- the update privilege 0009 granted covers a column added to the same table.
-- A trigger here would instead bump the revision for every other writer of the
-- table, including a fixture and a migration, which is a second opinion about
-- what counts as an administrator's write.
alter table public.business_settings
  add column revision integer not null default 1;

alter table public.business_settings
  add constraint business_settings_revision_counts_up check (revision >= 1);
