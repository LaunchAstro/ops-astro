-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Priority is one operation-owned business setting, not a second stage catalogue.
-- The six exact journey IDs mirror core-wire/task-stages.ts. Ops never qualifies.
-- The application orders input before writing; this predicate also rejects
-- duplicate, unknown, non-string and out-of-order values at the storage boundary.
create function public.priority_stage_ids_valid(value jsonb) returns boolean
  language plpgsql immutable strict
  set search_path = pg_catalog
as $$
declare
  id jsonb;
  stage_position integer;
  previous integer := 0;
  journey constant text[] := array['awareness', 'trust', 'enquiries', 'sales', 'retention', 'advocacy'];
begin
  if jsonb_typeof(value) <> 'array' then return false; end if;
  if jsonb_array_length(value) > 6 then return false; end if;
  for id in select jsonb_array_elements(value) loop
    if jsonb_typeof(id) <> 'string' then return false; end if;
    stage_position := array_position(journey, id #>> '{}');
    if stage_position is null or stage_position <= previous then return false; end if;
    previous := stage_position;
  end loop;
  return true;
end;
$$;

alter table public.business_settings
  drop constraint business_settings_value_type_known,
  drop constraint business_settings_value_matches_type;
alter table public.business_settings
  add constraint business_settings_value_type_known
    check (value_type in ('numeric', 'boolean', 'text', 'stage_ids')),
  add constraint business_settings_value_matches_type check (
    (value_type = 'numeric' and jsonb_typeof(value) in ('number', 'null')) or
    (value_type = 'boolean' and jsonb_typeof(value) = 'boolean') or
    (value_type = 'text' and jsonb_typeof(value) in ('string', 'null')) or
    (value_type = 'stage_ids' and public.priority_stage_ids_valid(value))
  ),
  add constraint business_settings_priority_classification check (
    (value_type <> 'stage_ids' or key = 'priority_stages') and
    (key <> 'priority_stages' or
      (value_type = 'stage_ids' and write_mode = 'operation' and
       owning_operation = array['settings.set_priority_stages'] and
       visibility_class = 'internal' and origin = 'core'))
  );

-- Migration runs under the existing migration authority. Add only missing rows;
-- neither an upgrade nor a repeated installer resets a business's choices.
insert into public.business_settings
  (business_id, id, key, label, value_type, value, write_mode, owning_operation,
   visibility_class, origin)
select business_id, gen_random_uuid(), 'priority_stages', 'Priority stages',
       'stage_ids', '[]'::jsonb, 'operation', array['settings.set_priority_stages'],
       'internal', 'core'
  from public.businesses
on conflict (business_id, key) do nothing;
