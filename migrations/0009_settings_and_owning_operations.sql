-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0009 the two model corrections the ledger names, and the settings table the
-- model has been referring to without having.
--
-- Correction one: `owning_operation` becomes `text[]`.
--
-- 0004 shipped it as `text` and 0006 wrote the sentence that explains why: a
-- field owned by three commands holds them "separated by single spaces", with
-- a regular expression to keep the spelling honest and every reader calling
-- `.split(' ')`. That works, and it is a list encoded in a string, which is a
-- second model of the same fact — the one the accepted domain model spells
-- `owning_operation text[]`. A string that has to be parsed is a string that
-- can be parsed differently, and the reader that forgets to split sees one
-- operation named `task.complete task.reopen task.start`, which exists
-- nowhere.
--
-- The conversion keeps every existing value: `string_to_array` on the same
-- separator the old constraint enforced, so no row changes meaning and the
-- old spelling remains recoverable as `array_to_string(...)`.
--
-- Correction two: `business_settings`, which several landed contracts read
-- (the four-eyes band, the retention window, the conversation window, the
-- client sign-off requirement) and none of them could, because the table was
-- named in the completion item and never built. Its rows are classified the
-- way field definitions are, because a setting that changes who may approve
-- money is not a value a generic editor should reach.

-- ---------------------------------------------------------------------------
-- owning_operation text[]
-- ---------------------------------------------------------------------------

-- The old check names both columns, so it goes before the type changes and a
-- replacement covering both comes back after.
alter table public.field_defs
  drop constraint field_defs_operation_names_are_operations;

alter table public.field_defs
  alter column owning_operation type text[]
  using case
         when owning_operation is null then null
         else string_to_array(owning_operation, ' ')
       end;

-- `field_defs_operation_named` from 0004 still holds: it reads null against
-- not null and never read the text. What it did not say is that an operation
-- field naming an empty list is the same absence wearing a different shape.
alter table public.field_defs
  add constraint field_defs_owning_operation_not_empty
  check (owning_operation is null or cardinality(owning_operation) > 0);

-- Every element is an operation name, and no element is null. `array_to_string`
-- drops nulls, so the shape check alone would let `{task.assign, null}` past;
-- `array_position` is what refuses it.
alter table public.field_defs
  add constraint field_defs_operation_names_are_operations
  check (
    (owning_operation is null or
     (array_position(owning_operation, null) is null and
      array_to_string(owning_operation, ' ')
        ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*( [a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)*$'))
    and
    (escalating_operation is null or
     escalating_operation ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$')
  );

-- ---------------------------------------------------------------------------
-- business_settings
-- ---------------------------------------------------------------------------

-- One row per setting per business, not one row of many columns, because the
-- set grows by configuration and a column per setting is a migration per
-- product decision.
--
-- `write_mode` carries the same three values `field_defs` does and means the
-- same thing: `generic` is edited directly by a caller who may manage
-- settings, `operation` is owned by a named command and refused to a generic
-- write, `system` is derived and written by nothing. There is no default,
-- for the reason 0004 gives: a setting nobody classified is a setting nobody
-- decided about.
--
-- `value` is json so that a threshold, a window and a boolean are one table.
-- `value_type` says which of them this row is, and the check makes the pair
-- agree rather than trusting the writer.
create table public.business_settings (
  business_id      uuid        not null,
  id               uuid        not null,
  key              text        not null,
  label            text        not null,
  value_type       text        not null,
  value            jsonb       not null,
  write_mode       text        not null,
  owning_operation text[],
  -- Whether the client-facing projection may see it. Deny by default, as
  -- fields do.
  visibility_class text        not null default 'internal',
  origin           text        not null default 'core',
  updated_at       timestamptz not null default now(),
  updated_by_actor_id uuid,
  constraint business_settings_pkey primary key (id),
  constraint business_settings_tenant_id_key unique (business_id, id),
  constraint business_settings_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint business_settings_updated_by_fkey foreign key (business_id, updated_by_actor_id)
    references public.actors (business_id, id),
  constraint business_settings_key_shape check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  constraint business_settings_label_present check (length(btrim(label)) > 0),
  constraint business_settings_value_type_known
    check (value_type in ('numeric', 'boolean', 'text')),
  constraint business_settings_write_mode_known
    check (write_mode in ('generic', 'operation', 'system')),
  constraint business_settings_operation_named
    check ((write_mode = 'operation') = (owning_operation is not null)),
  constraint business_settings_owning_operation_not_empty
    check (owning_operation is null or cardinality(owning_operation) > 0),
  constraint business_settings_operation_names_are_operations check (
    owning_operation is null or
    (array_position(owning_operation, null) is null and
     array_to_string(owning_operation, ' ')
       ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*( [a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)*$')
  ),
  constraint business_settings_visibility_class_known
    check (visibility_class in ('internal', 'shared')),
  constraint business_settings_origin_known check (origin in ('core', 'preset')),
  -- The stored value is of the type the row says it is. A four-eyes band that
  -- arrived as the string "500" is a band no comparison reads.
  constraint business_settings_value_matches_type check (
    (value_type = 'numeric' and jsonb_typeof(value) in ('number', 'null')) or
    (value_type = 'boolean' and jsonb_typeof(value) = 'boolean') or
    (value_type = 'text' and jsonb_typeof(value) in ('string', 'null'))
  )
);

-- One row per key per business.
create unique index business_settings_key_idx
  on public.business_settings (business_id, key);

alter table public.business_settings enable row level security;
alter table public.business_settings force row level security;

create policy tenancy_business_settings on public.business_settings
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_business_settings on public.business_settings
  as permissive
  for all
  using (true)
  with check (true);

-- No DELETE. A setting is reset to its default value, not removed, so that a
-- reader asking for a key never has to decide what an absent row means.
grant select, insert, update on public.business_settings to ops_astro_app;

-- ---------------------------------------------------------------------------
-- The free slots get their indexes.
-- ---------------------------------------------------------------------------

-- 0005 indexed the sixteen the task spine reserves and 0006 added the two it
-- took later. The other twenty columns exist and carry no index, and
-- `planSlotAssignment` refuses to place a field in an unindexed slot --
-- correctly, because the entire point of a slot is a value that can be
-- filtered, sorted and grouped, and handing a preset an unindexed column would
-- be promising that and delivering a sequential scan.
--
-- The consequence, before this migration: `preset.plan` could not place a
-- single field of any type. Every free text, timestamp, numeric and boolean
-- slot was unindexed, and the one free uuid slot the core had indexed was
-- reserved. A planner whose only possible answer is `SLOT_INDEX_ABSENT` is not
-- a planner, so the indexes the slot table has been promising land here.
--
-- Same shape as 0005's, partial on `deleted_at is null` for the same reason:
-- a trashed record is not a row any filter is looking for.
create index records_uuid_8_idx
  on public.records (business_id, record_type_id, uuid_8) where deleted_at is null;
create index records_uuid_9_idx
  on public.records (business_id, record_type_id, uuid_9) where deleted_at is null;
create index records_uuid_10_idx
  on public.records (business_id, record_type_id, uuid_10) where deleted_at is null;
create index records_txt_7_idx
  on public.records (business_id, record_type_id, txt_7) where deleted_at is null;
create index records_txt_8_idx
  on public.records (business_id, record_type_id, txt_8) where deleted_at is null;
create index records_txt_9_idx
  on public.records (business_id, record_type_id, txt_9) where deleted_at is null;
create index records_txt_10_idx
  on public.records (business_id, record_type_id, txt_10) where deleted_at is null;
create index records_txt_11_idx
  on public.records (business_id, record_type_id, txt_11) where deleted_at is null;
create index records_txt_12_idx
  on public.records (business_id, record_type_id, txt_12) where deleted_at is null;
create index records_ts_3_idx
  on public.records (business_id, record_type_id, ts_3) where deleted_at is null;
create index records_ts_4_idx
  on public.records (business_id, record_type_id, ts_4) where deleted_at is null;
create index records_ts_5_idx
  on public.records (business_id, record_type_id, ts_5) where deleted_at is null;
create index records_num_3_idx
  on public.records (business_id, record_type_id, num_3) where deleted_at is null;
create index records_num_4_idx
  on public.records (business_id, record_type_id, num_4) where deleted_at is null;
create index records_num_5_idx
  on public.records (business_id, record_type_id, num_5) where deleted_at is null;
create index records_num_6_idx
  on public.records (business_id, record_type_id, num_6) where deleted_at is null;
create index records_bool_2_idx
  on public.records (business_id, record_type_id, bool_2) where deleted_at is null;
create index records_bool_3_idx
  on public.records (business_id, record_type_id, bool_3) where deleted_at is null;
create index records_bool_4_idx
  on public.records (business_id, record_type_id, bool_4) where deleted_at is null;
create index records_bool_5_idx
  on public.records (business_id, record_type_id, bool_5) where deleted_at is null;
