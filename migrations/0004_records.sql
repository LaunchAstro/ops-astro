-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0004 record types and fields. The configuration half of the records engine:
-- the slot catalogue, configured record types, and the field definitions that
-- carry a field's slot, its write mode and its visibility class. The store the
-- configuration drives is 0005, and the two land together.
--
-- The law this migration exists to hold is that adding a record type or a
-- field writes metadata rows and never creates a table, a column or an index
-- (ADR 0030). Everything a person can configure is data here; everything that
-- costs a schema change is in this file and arrives by review.
--
-- Everything here inherits 0001's four rules and does not restate them:
-- `business_id uuid not null` and indexed, row security enabled and forced,
-- one restrictive policy on the session setting with a permissive baseline
-- beside it, composite foreign keys leading with `business_id` on both sides,
-- and an application role that owns nothing and creates nothing.

-- ---------------------------------------------------------------------------
-- The slot catalogue.
-- ---------------------------------------------------------------------------

-- The slot table is installation-wide, not per business: the columns exist on
-- `records` for everybody, and which of them the core has reserved is a fact
-- about this build rather than about a tenant. So it lives in `ops` beside the
-- migration ledger and is not an application table.
--
-- It carries no `indexed` column on purpose. Whether a slot has an index is
-- read from the catalogue that the indexes below actually created, so the
-- registry cannot claim an index the server does not have. Two records of one
-- fact is the same mistake the trigger exists to prevent.
create table ops.slots (
  slot        text not null primary key,
  value_type  text not null,
  -- Null means free for a preset field. A named holder means the core reserved
  -- it, and a preset naming it is refused SLOT_RESERVED (fixed slots, 3.2).
  reservation text,
  constraint slots_value_type_known
    check (value_type in ('uuid', 'text', 'timestamptz', 'numeric', 'boolean')),
  -- The name says the type. A `txt_3` holding timestamps would be a slot whose
  -- name lies, and every refusal below reads the name.
  constraint slots_name_matches_type check (
    (value_type = 'uuid' and slot ~ '^uuid_[0-9]+$') or
    (value_type = 'text' and slot ~ '^txt_[0-9]+$') or
    (value_type = 'timestamptz' and slot ~ '^ts_[0-9]+$') or
    (value_type = 'numeric' and slot ~ '^num_[0-9]+$') or
    (value_type = 'boolean' and slot ~ '^bool_[0-9]+$')
  )
);

-- Thirty-eight slots: ten uuid, twelve text, five timestamp, six numeric, five
-- boolean (fixed slots, 2.1). The sixteen the task spine reserves are reserved
-- here, in the core migration and before any preset field exists, because a
-- reservation a preset sync could win a race against is not a reservation.
insert into ops.slots (slot, value_type, reservation)
select 'uuid_' || n, 'uuid', case when n <= 6 then 'task_spine' end from generate_series(1, 10) as n
union all
select 'txt_' || n, 'text', case when n <= 6 then 'task_spine' end from generate_series(1, 12) as n
union all
select 'ts_' || n, 'timestamptz', case when n <= 2 then 'task_spine' end from generate_series(1, 5) as n
union all
select 'num_' || n, 'numeric', case when n <= 2 then 'task_spine' end from generate_series(1, 6) as n
union all
select 'bool_' || n, 'boolean', null from generate_series(1, 5) as n;

grant usage on schema ops to ops_astro_app;
grant select on ops.slots to ops_astro_app;

-- ---------------------------------------------------------------------------
-- Record types.
-- ---------------------------------------------------------------------------

-- A configured kind of record. Adding one writes a row; it never creates a
-- table. `retention_class` is here rather than on the record because every
-- record of a type retains alike, and the purge operation refuses to name a
-- table in the evidence class (specification, 14.3).
create table public.record_types (
  business_id     uuid        not null,
  id              uuid        not null,
  key             text        not null,
  name            text        not null,
  origin          text        not null default 'preset',
  retention_class text        not null default 'work',
  created_at      timestamptz not null default now(),
  constraint record_types_pkey primary key (id),
  constraint record_types_tenant_id_key unique (business_id, id),
  constraint record_types_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint record_types_key_present check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  constraint record_types_name_present check (length(btrim(name)) > 0),
  constraint record_types_origin_known check (origin in ('core', 'preset')),
  constraint record_types_retention_class_known
    check (retention_class in ('work', 'evidence', 'runtime'))
);

create unique index record_types_key_idx on public.record_types (business_id, key);

alter table public.record_types enable row level security;
alter table public.record_types force row level security;

create policy tenancy_record_types on public.record_types
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_record_types on public.record_types
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on public.record_types to ops_astro_app;

-- ---------------------------------------------------------------------------
-- Field definitions.
-- ---------------------------------------------------------------------------

-- The field definition is where a field's classification lives, not the task
-- module (minimum contract, 5.1). Because the records engine reads it, every
-- surface inherits the refusal: the app, the API, the CLI and any later
-- generic editor hit the same check, and no authority check sits in one
-- transport alone.
create table public.field_defs (
  business_id      uuid        not null,
  id               uuid        not null,
  record_type_id   uuid        not null,
  key              text        not null,
  label            text        not null,
  value_type       text        not null,
  -- Null means the field lives in `data` only: readable, writable, and not
  -- filterable, sortable or groupable until it is given a slot.
  slot             text,
  write_mode       text        not null,
  owning_operation text,
  visibility_class text        not null default 'internal',
  searchable       boolean     not null default false,
  unique_value     boolean     not null default false,
  origin           text        not null default 'preset',
  created_at       timestamptz not null default now(),
  deactivated_at   timestamptz,
  constraint field_defs_pkey primary key (id),
  constraint field_defs_tenant_id_key unique (business_id, id),
  constraint field_defs_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint field_defs_record_type_fkey foreign key (business_id, record_type_id)
    references public.record_types (business_id, id),
  constraint field_defs_key_present check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  constraint field_defs_label_present check (length(btrim(label)) > 0),
  constraint field_defs_value_type_known
    check (value_type in ('uuid', 'text', 'timestamptz', 'numeric', 'boolean', 'json')),
  constraint field_defs_origin_known check (origin in ('core', 'preset')),
  -- Every field carries a classification. There is no default to `generic`,
  -- because a field nobody classified is a field nobody decided about, and
  -- defaulting it open is how a protected transition acquires a side door.
  constraint field_defs_write_mode_known
    check (write_mode in ('generic', 'operation', 'system')),
  -- An operation-owned field names its operation and nothing else does. A
  -- system field is derived and has no operation to name (specification,
  -- 14.1); a generic field is edited directly. Equality rather than an
  -- implication, so neither half can drift from the other.
  constraint field_defs_operation_named
    check ((write_mode = 'operation') = (owning_operation is not null)),
  constraint field_defs_visibility_class_known
    check (visibility_class in ('internal', 'shared')),
  -- The slot's name says its type, so a field and its slot must agree. A
  -- `json` field is never slottable: the whole point of a slot is one typed
  -- comparable value.
  constraint field_defs_slot_matches_type check (
    slot is null or
    (value_type = 'uuid' and slot ~ '^uuid_[0-9]+$') or
    (value_type = 'text' and slot ~ '^txt_[0-9]+$') or
    (value_type = 'timestamptz' and slot ~ '^ts_[0-9]+$') or
    (value_type = 'numeric' and slot ~ '^num_[0-9]+$') or
    (value_type = 'boolean' and slot ~ '^bool_[0-9]+$')
  ),
  -- Search reads slotted text (fixed slots, 5.3 F1 and F2). A searchable
  -- number is a promise the trigger cannot keep.
  constraint field_defs_searchable_is_slotted_text
    check (not searchable or (value_type = 'text' and slot is not null))
);

create unique index field_defs_key_idx
  on public.field_defs (business_id, record_type_id, key);

-- One field per slot per record type, and the constraint covers deactivated
-- fields too. A slot is never reused after a field is deactivated until an
-- audited reclaim runs (fixed slots, 3.1), because a reused slot carrying a
-- stale backfill puts one field's values under another field's name.
create unique index field_defs_slot_idx
  on public.field_defs (business_id, record_type_id, slot)
  where slot is not null;

-- The trigger reads this on every record write, so it is the shape the trigger
-- asks for rather than a general-purpose index.
create index field_defs_projection_idx
  on public.field_defs (business_id, record_type_id)
  where slot is not null and deactivated_at is null;

alter table public.field_defs enable row level security;
alter table public.field_defs force row level security;

create policy tenancy_field_defs on public.field_defs
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_field_defs on public.field_defs
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on public.field_defs to ops_astro_app;

-- ---------------------------------------------------------------------------
-- Immutability.
-- ---------------------------------------------------------------------------

-- A type's key and identifier are immutable, and a field's type is immutable
-- after creation (CONTEXT.md; fixed slots, 3.1 rule 4). Held here rather than
-- in a command, because a rule that lives in one command is a rule the next
-- entry point forgets. The columns are named by the trigger's arguments so one
-- function serves every table that has some.
create function public.refuse_immutable_columns() returns trigger
  language plpgsql
  as $$
  declare
    column_name text;
    was         jsonb := to_jsonb(old);
    now_is      jsonb := to_jsonb(new);
  begin
    foreach column_name in array tg_argv loop
      if was -> column_name is distinct from now_is -> column_name then
        raise exception 'IMMUTABLE_FIELD: %.% cannot change once written',
          tg_table_name, column_name
          using errcode = 'restrict_violation';
      end if;
    end loop;
    return new;
  end;
  $$;

revoke execute on function public.refuse_immutable_columns() from public;

create trigger record_types_immutable
  before update on public.record_types
  for each row execute function public.refuse_immutable_columns('id', 'key', 'business_id');

create trigger field_defs_immutable
  before update on public.field_defs
  for each row
  execute function public.refuse_immutable_columns('id', 'key', 'business_id', 'value_type', 'record_type_id');
