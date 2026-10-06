-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The person an agent's comment is written for (catalogue #414, OW-036.1).
--
-- One agent actor writes for every person who delegates to it, so a comment's
-- author actor alone does not say whose words it holds. The comment type's
-- `on_behalf_of` field records the person: system-written from the
-- delegation (or an agent credential's person), internal, in `data` only
-- (`packages/core-records/src/tasks/comments.ts`). Like every comment field it
-- is a metadata row, not a column (ADR 0037). What cannot be a row is here:
-- the field row for the comment types installed before it was declared, as
-- 0075 did for `parent`.

-- A preset field already holding the key is not the core's to move: refused,
-- by name. No preset extends the comment type today.
do $$
declare
  held record;
begin
  select f.business_id, f.key
    into held
    from public.field_defs f
    join public.record_types t on t.business_id = f.business_id and t.id = f.record_type_id
   where t.key = 'task_comment' and f.origin <> 'core' and f.key = 'on_behalf_of'
   limit 1;
  if found then
    raise exception 'field_defs: comment field % is reserved by the core (business %)',
      held.key, held.business_id
      using errcode = 'check_violation';
  end if;
end;
$$;

-- The row `installTaskSpine` writes for a new business: a uuid in no slot,
-- system-written, internal, core. A type that already has it is left alone.
insert into public.field_defs
  (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
   owning_operation, escalating_operation, visibility_class, searchable,
   unique_value, origin)
select t.business_id, gen_random_uuid(), t.id, 'on_behalf_of', 'On behalf of', 'uuid', null,
       'system', null, null, 'internal', false, false, 'core'
  from public.record_types t
 where t.key = 'task_comment'
   and not exists (
     select 1 from public.field_defs f
      where f.business_id = t.business_id and f.record_type_id = t.id and f.key = 'on_behalf_of'
   );
