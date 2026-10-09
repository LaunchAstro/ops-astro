-- SPDX-License-Identifier: AGPL-3.0-only
-- R70 / MP-4-9: a nullable typed task start date, never a stored rank.
-- Existing absent/null dates stay absent/null. No history or timer is guessed.
-- Unslotted fields are validated by the normal records metadata/trigger.
-- Existing installations gain the same field that installTaskSpine declares.
do $$
begin
  if exists (
    select 1 from public.field_defs f
    join public.record_types t on t.business_id = f.business_id and t.id = f.record_type_id
    where t.key = 'task' and f.key = 'started_at'
      and (f.origin <> 'core' or f.value_type <> 'timestamptz'
        or f.slot is not null or f.write_mode <> 'generic'
        or f.owning_operation is not null or f.escalating_operation is not null
        or f.visibility_class <> 'internal')
  ) then
    raise exception 'task.started_at: an incompatible field already owns the key';
  end if;
end;
$$;

insert into public.field_defs
  (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
   owning_operation, escalating_operation, visibility_class, searchable, unique_value, origin)
select t.business_id, gen_random_uuid(), t.id, 'started_at', 'Started at',
       'timestamptz', null, 'generic', null, null, 'internal', false, false, 'core'
from public.record_types t
where t.key = 'task' and not exists (
  select 1 from public.field_defs f
  where f.business_id = t.business_id and f.record_type_id = t.id and f.key = 'started_at'
);
