-- SPDX-License-Identifier: AGPL-3.0-only
--
-- A time entry ends at or after it starts. A stop used to stamp its end with
-- its transaction's start, so a stop that found a timer a newer transaction
-- had started could end it before it began (`stopTimer`,
-- `packages/core-records/src/tasks/time.ts`, now reads the clock once it holds
-- the entry). 0078's checks held the shape, not the order.
--
-- An entry written before this check with its end before its start ends at
-- its start instead: the gap is the milliseconds between two transactions,
-- and its minutes, the number billing reads, stay as they were. No function
-- is added; `time_entries` keeps 0078's forced row security.

update public.time_entries
   set ended_at = started_at
 where ended_at < started_at;

alter table public.time_entries
  add constraint time_entries_ends_after_start check (ended_at is null or ended_at >= started_at);
