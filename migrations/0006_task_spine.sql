-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0006 the task spine. What the task record type needs from the schema, and
-- nothing that a row could carry instead.
--
-- There is no `tasks` table here and there never will be one (ADR 0037). The
-- task type is metadata rows written by the installer in
-- `packages/core-records/src/tasks/install.ts`, per business, at runtime. What
-- cannot be a row is in this file: a check constraint, two slot indexes, and
-- one column that lets a landed contract row be written down at all.
--
-- Everything here inherits 0001's four rules and does not restate them, and
-- adds nothing to the twenty-eight tables specification 9.1 fixes.

-- ---------------------------------------------------------------------------
-- The subtask placement invariant.
-- ---------------------------------------------------------------------------

-- A record with a parent cannot carry a board section (specification, 14.2
-- point 4). The legacy held this in a placement helper that several creation
-- routes bypassed; the new core has five entry points from the start, so the
-- rule is held where no entry point can miss it.
--
-- It names `uuid_4` and `uuid_6` rather than "the task type's parent and board
-- section", because a check constraint cannot read `field_defs`. That is safe
-- precisely because those two slots are reserved: no preset field can be
-- assigned to either, so no other record type can be caught by a rule about a
-- task. If the reservation ever moved, this constraint would have to move with
-- it, and the conformance set asserts both together.
--
-- The board itself is deliberately not constrained: a subtask **inherits** its
-- parent's board (14.2 point 2), so `uuid_5` is non-null for subtasks and only
-- the section is forced empty.
alter table public.records
  add constraint records_subtask_has_no_board_section
  check (uuid_4 is null or uuid_6 is null);

-- ---------------------------------------------------------------------------
-- Two more reserved slots, and the indexes that make them assignable.
-- ---------------------------------------------------------------------------

-- Fixed slots 2.2 reserves sixteen, drawn before the census had finished
-- classifying the task's fields. Two of the fields that classification
-- produced are protected and have no reserved slot: `client_visible`, the
-- disclosure boundary, and the party link a party-scoped grant resolves
-- against (fixed slots, 4.1). Specification 2.3 case T1-N3 requires a generic
-- write to each of them to be refused on all three surfaces, which a field
-- that does not exist cannot do.
--
-- So the spine takes eighteen slots rather than sixteen. Adding the two here
-- is the mechanism fixed slots 2.3 names — "ship indexes only for the slots
-- the first slice's views actually filter, sort or group on; add later slot
-- indexes by migration" — used for a spine field rather than a preset one.
-- Sixteen free slots remain: three uuid, six text, three timestamp, four
-- numeric, four boolean.
--
-- The reservation is updated in the same file as the indexes, because the two
-- facts have to move together: a reserved slot with no index is refused by the
-- conformance set, and an indexed slot nobody reserved is a slot a preset can
-- take before the core installs.
create index records_uuid_7_idx
  on public.records (business_id, record_type_id, uuid_7) where deleted_at is null;
create index records_bool_1_idx
  on public.records (business_id, record_type_id, bool_1) where deleted_at is null;

update ops.slots set reservation = 'task_spine' where slot in ('uuid_7', 'bool_1');

-- ---------------------------------------------------------------------------
-- The conditional half of a field's classification.
-- ---------------------------------------------------------------------------

-- Two landed contracts classify `board` and `board_section` as "generic within
-- a board the caller may already write; otherwise `task.move`" (minimum
-- contract 5.2, fixed slots 4.1, specification 14.2 point 5). `write_mode`
-- holds one value and `owning_operation` is null unless the mode is
-- `operation`, so as T1d shaped the table that sentence has nowhere to live:
-- the field records either "always generic", losing the escalation, or "always
-- owned", refusing the ordinary drag between two sections of one board.
--
-- This column is that sentence, written down. The records engine does **not**
-- refuse on it — an ordinary write to a generic field stays ordinary — and the
-- owning command reads it to decide whether the write it has been handed
-- crosses a containment boundary. Naming the operation in the data rather than
-- inside one command is the same argument `write_mode` itself rests on: a list
-- held in a module is a check to remember.
alter table public.field_defs add column escalating_operation text;

-- Only a generic field escalates. A field already owned by an operation has
-- one owner and needs no second one, and allowing both would be two answers to
-- "which command may write this".
alter table public.field_defs
  add constraint field_defs_escalation_is_generic
  check (escalating_operation is null or write_mode = 'generic');

-- ---------------------------------------------------------------------------
-- What an operation name looks like.
-- ---------------------------------------------------------------------------

-- `state` is owned by three commands — complete, reopen and start (minimum
-- contract 5.2) — and `owning_operation` is one text column. The value is the
-- operations separated by single spaces, and the refusal names all of them,
-- because a caller told to call `task.complete` when they meant to reopen has
-- been told the wrong thing.
--
-- The shape is constrained here rather than left to convention so that T1f,
-- which builds the command register, can parse the column instead of guessing
-- whether it holds one name or several. Both columns take the same shape.
alter table public.field_defs
  add constraint field_defs_operation_names_are_operations
  check (
    (owning_operation is null or
     owning_operation ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*( [a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)*$')
    and
    (escalating_operation is null or
     escalating_operation ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$')
  );
