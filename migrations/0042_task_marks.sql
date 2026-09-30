-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0042 the three marks the derived rank reads: impact, confidence and ease
-- (MP-4-9, R70).
--
-- Each is a whole number from 1 to 10 or absent, and absent is never 0: a task
-- missing a mark is "not ranked", not ranked last. They are task spine fields
-- owned by `task.set_scores` (`packages/core-records/src/tasks/spine.ts`), so
-- like every task field they are metadata rows over fixed slots, not columns
-- of a tasks table (ADR 0037). What cannot be a row is here: the reservation
-- of three numeric slots, the check that holds the range in the database, and
-- the field rows for the task types that were installed before the marks were
-- declared.

-- ---------------------------------------------------------------------------
-- Three more reserved slots.
-- ---------------------------------------------------------------------------

-- `num_3` to `num_5` were free for a preset field, and their indexes exist
-- (0009). A preset field already holding one would be caught by the range
-- check below, which is a rule about a task, so this migration refuses rather
-- than constrain a field it does not own. No preset ships a numeric field
-- today; the refusal is for an installation that synced its own.
do $$
declare
  held record;
begin
  select f.business_id, f.record_type_id, f.key, f.slot
    into held
    from public.field_defs f
   where f.slot in ('num_3', 'num_4', 'num_5') and f.origin <> 'core'
   limit 1;
  if found then
    raise exception 'field_defs: % holds %, which the task marks reserve (record type % in business %)',
      held.key, held.slot, held.record_type_id, held.business_id
      using errcode = 'check_violation';
  end if;
end;
$$;

update ops.slots set reservation = 'task_spine' where slot in ('num_3', 'num_4', 'num_5');

-- ---------------------------------------------------------------------------
-- The range, held where no entry point can miss it.
-- ---------------------------------------------------------------------------

-- The command refuses an out-of-range mark by name before it writes. These
-- hold the same rule for a write that never reached the command: the
-- projection trigger fills the slot from `data`, so an 11 in `data` raises
-- here rather than being stored and ranked. They name slots rather than
-- fields for the reason 0006 gives: a check constraint cannot read
-- `field_defs`, and the slots are reserved, so no other record type is caught
-- by a rule about a task.
alter table public.records
  add constraint records_task_impact_is_a_mark
  check (num_3 is null or (num_3 between 1 and 10 and num_3 = trunc(num_3)));
alter table public.records
  add constraint records_task_confidence_is_a_mark
  check (num_4 is null or (num_4 between 1 and 10 and num_4 = trunc(num_4)));
alter table public.records
  add constraint records_task_ease_is_a_mark
  check (num_5 is null or (num_5 between 1 and 10 and num_5 = trunc(num_5)));

-- ---------------------------------------------------------------------------
-- A preset field that already holds one of the three keys, moved aside.
-- ---------------------------------------------------------------------------

-- A field's key is unique on its record type, deactivated fields included,
-- and immutable (0004). So a preset field a business synced as `impact`,
-- `confidence` or `ease` on its task type would keep the key, the backfill
-- below would skip it, and `task.set_scores` would then refuse the mark as a
-- field it does not own (Sol, review 1 of #141, criterion 7). The preset field
-- is not the core's to drop: its definition and every value stored under it
-- move to `preset_<key>`, unchanged, and its uniqueness claims are released
-- here and taken again by the records trigger under the new field. A business
-- that already has `preset_<key>` too fails this migration by name rather
-- than lose either. The records moved gain one revision.
do $$
declare
  held record;
  aside text;
begin
  for held in
    select f.*
      from public.field_defs f
      join public.record_types t on t.business_id = f.business_id and t.id = f.record_type_id
     where t.key = 'task' and f.origin <> 'core' and f.key in ('impact', 'confidence', 'ease')
  loop
    aside := 'preset_' || held.key;
    if exists (
      select 1 from public.field_defs f
       where f.business_id = held.business_id and f.record_type_id = held.record_type_id
         and f.key = aside
    ) then
      raise exception 'field_defs: task field % cannot move aside to %, which is taken (business %)',
        held.key, aside, held.business_id
        using errcode = 'unique_violation';
    end if;
    delete from public.record_unique_values
     where business_id = held.business_id and field_def_id = held.id;
    delete from public.field_defs where business_id = held.business_id and id = held.id;
    insert into public.field_defs
      (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
       owning_operation, escalating_operation, visibility_class, searchable,
       unique_value, origin, created_at, deactivated_at)
    values
      (held.business_id, gen_random_uuid(), held.record_type_id, aside, held.label,
       held.value_type, held.slot, held.write_mode, held.owning_operation,
       held.escalating_operation, held.visibility_class, held.searchable,
       held.unique_value, held.origin, held.created_at, held.deactivated_at);
    update public.records
       set data = (data - held.key) || jsonb_build_object(aside, data -> held.key)
     where business_id = held.business_id and record_type_id = held.record_type_id
       and data ? held.key;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The fields, on every task type already installed.
-- ---------------------------------------------------------------------------

-- The installer writes the spine once per business and never reads it again,
-- so a business installed before this migration has no marks, and a database
-- brought up to date with `db:migrate` alone would answer `task.set_scores`
-- with FIELD_UNKNOWN. The rows are the ones `installTaskSpine` writes for a
-- new business: numeric, owned by `task.set_scores`, internal, core. A type
-- that already has the core field of the key is left alone; a preset one was
-- moved aside above.
insert into public.field_defs
  (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
   owning_operation, escalating_operation, visibility_class, searchable,
   unique_value, origin)
select t.business_id, gen_random_uuid(), t.id, mark.key, mark.label, 'numeric', mark.slot,
       'operation', array['task.set_scores'], null, 'internal', false, false, 'core'
  from public.record_types t
 cross join (values ('impact', 'Impact', 'num_3'),
                    ('confidence', 'Confidence', 'num_4'),
                    ('ease', 'Ease', 'num_5')) as mark (key, label, slot)
 where t.key = 'task'
   and not exists (
     select 1 from public.field_defs f
      where f.business_id = t.business_id and f.record_type_id = t.id and f.key = mark.key
   );
