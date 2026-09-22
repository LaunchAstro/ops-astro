-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0005 the record store. Where records themselves live: the sized slot table,
-- links, uniqueness, and the trigger that keeps a slot and the `data` it is
-- projected from in step.
--
-- It is a second file rather than the tail of 0004 because the per-file review
-- cap is 400 hand-written lines and no waiver lifts it. The pair is one change
-- and lands together; 0004 is the configuration a person edits, and this is
-- the storage that configuration drives.
--
-- The direction of the projection is the thing to read first. `data` is what a
-- writer supplies. A slot is a derived copy of one of its values, recomputed on
-- every write with no path around it: writing a slot column directly does not
-- persist, because the trigger below rebuilds every slot from `data` before the
-- row lands. A slot that can be written independently is a second owner of one
-- fact, and the pair disagreeing quietly is the failure the fixed-slot design
-- replaced generated columns to avoid.
--
-- Everything here inherits 0001's four rules and does not restate them:
-- `business_id uuid not null` and indexed, row security enabled and forced, one
-- restrictive policy on the session setting with a permissive baseline beside
-- it, composite foreign keys leading with `business_id` on both sides, and an
-- application role that owns nothing and creates nothing.

-- ---------------------------------------------------------------------------
-- Records, and the sized slot table.
-- ---------------------------------------------------------------------------

-- One table for every record of every type. There is no `tasks` table and
-- there never will be one (ADR 0037).
--
-- Thirty-eight nullable slot columns cost a null bitmap and nothing else, and
-- the table is nowhere near PostgreSQL's column ceiling. Thirty-eight indexes
-- would cost write amplification forever, so only the reserved spine slots are
-- indexed below and a later slot index arrives by migration (fixed slots,
-- 2.3). Until it does, the engine refuses to slot a field there with
-- SLOT_INDEX_ABSENT rather than letting "a slotted field is a fast field"
-- quietly stop being true.
create table public.records (
  business_id          uuid        not null,
  id                   uuid        not null,
  record_type_id       uuid        not null,
  -- Everything a person configures. The slots below are projections of named
  -- values in here; nothing else reads it for filtering, and there is no
  -- containment index over it (E19 law 10).
  data                 jsonb       not null default '{}'::jsonb,
  -- Maintained by the trigger from searchable slotted text fields, so a term
  -- that lives only in unsearchable `data` is genuinely not found rather than
  -- found sometimes.
  search_tsv           tsvector,
  -- What `expected_revision` is checked against. The trigger bumps it, so
  -- there is no write path that leaves it behind.
  revision             bigint      not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- The trash envelope. None of the three is a slot (specification, 9.1); the
  -- batch is stamped across a subtree by `task.trash`, which is T1e's.
  deleted_at           timestamptz,
  deleted_by_actor_id  uuid,
  trash_batch_id       uuid,

  uuid_1  uuid, uuid_2  uuid, uuid_3  uuid, uuid_4  uuid, uuid_5  uuid,
  uuid_6  uuid, uuid_7  uuid, uuid_8  uuid, uuid_9  uuid, uuid_10 uuid,

  txt_1   text, txt_2   text, txt_3   text, txt_4   text, txt_5   text,
  txt_6   text, txt_7   text, txt_8   text, txt_9   text, txt_10  text,
  txt_11  text, txt_12  text,

  ts_1    timestamptz, ts_2 timestamptz, ts_3 timestamptz,
  ts_4    timestamptz, ts_5 timestamptz,

  num_1   numeric, num_2 numeric, num_3 numeric,
  num_4   numeric, num_5 numeric, num_6 numeric,

  bool_1  boolean, bool_2 boolean, bool_3 boolean, bool_4 boolean, bool_5 boolean,

  constraint records_pkey primary key (id),
  constraint records_tenant_id_key unique (business_id, id),
  constraint records_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint records_type_fkey foreign key (business_id, record_type_id)
    references public.record_types (business_id, id),
  constraint records_deleted_by_fkey foreign key (business_id, deleted_by_actor_id)
    references public.actors (business_id, id),
  constraint records_data_is_an_object check (jsonb_typeof(data) = 'object'),
  -- Trash is one fact with three parts. A row in the trash names when, by whom
  -- and in which batch, so a restore has a batch to restore and an audit has an
  -- actor to name.
  constraint records_trash_is_whole check (
    (deleted_at is null) = (deleted_by_actor_id is null) and
    (deleted_at is null) = (trash_batch_id is null)
  ),
  constraint records_revision_counts_up check (revision >= 1)
);

-- The working set. Every default query path filters `deleted_at is null`
-- (E19 law 8), so the index the engine actually uses says so too.
create index records_type_idx
  on public.records (business_id, record_type_id)
  where deleted_at is null;

-- Restore takes a batch identity and returns exactly the rows carrying it.
create index records_trash_batch_idx
  on public.records (business_id, trash_batch_id)
  where trash_batch_id is not null;

create index records_search_idx
  on public.records using gin (search_tsv)
  where deleted_at is null;

-- The sixteen reserved spine slots, in E19's shape. The twenty-two free slots
-- carry no index until a view needs one, which is the whole argument of
-- fixed slots 2.3 written out as sixteen statements rather than thirty-eight.
create index records_uuid_1_idx on public.records (business_id, record_type_id, uuid_1) where deleted_at is null;
create index records_uuid_2_idx on public.records (business_id, record_type_id, uuid_2) where deleted_at is null;
create index records_uuid_3_idx on public.records (business_id, record_type_id, uuid_3) where deleted_at is null;
create index records_uuid_4_idx on public.records (business_id, record_type_id, uuid_4) where deleted_at is null;
create index records_uuid_5_idx on public.records (business_id, record_type_id, uuid_5) where deleted_at is null;
create index records_uuid_6_idx on public.records (business_id, record_type_id, uuid_6) where deleted_at is null;
create index records_txt_1_idx on public.records (business_id, record_type_id, txt_1) where deleted_at is null;
create index records_txt_2_idx on public.records (business_id, record_type_id, txt_2) where deleted_at is null;
create index records_txt_3_idx on public.records (business_id, record_type_id, txt_3) where deleted_at is null;
create index records_txt_4_idx on public.records (business_id, record_type_id, txt_4) where deleted_at is null;
create index records_txt_5_idx on public.records (business_id, record_type_id, txt_5) where deleted_at is null;
create index records_txt_6_idx on public.records (business_id, record_type_id, txt_6) where deleted_at is null;
create index records_ts_1_idx on public.records (business_id, record_type_id, ts_1) where deleted_at is null;
create index records_ts_2_idx on public.records (business_id, record_type_id, ts_2) where deleted_at is null;
create index records_num_1_idx on public.records (business_id, record_type_id, num_1) where deleted_at is null;
create index records_num_2_idx on public.records (business_id, record_type_id, num_2) where deleted_at is null;

alter table public.records enable row level security;
alter table public.records force row level security;

create policy tenancy_records on public.records
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_records on public.records
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on public.records to ops_astro_app;

-- ---------------------------------------------------------------------------
-- Links.
-- ---------------------------------------------------------------------------

-- Relationships between records, one link type per relation. A view may
-- traverse one hop through a defined link type and no more; there are no
-- user-defined joins (E19 law 5), and the refusal for a second hop is the
-- view validator's.
--
-- Both ends are composite keys leading with `business_id`, so a link from a
-- record in one business to a record in another is refused by the foreign key
-- rather than by a check somebody remembered to write.
create table public.record_links (
  business_id    uuid        not null,
  id             uuid        not null,
  link_type      text        not null,
  from_record_id uuid        not null,
  to_record_id   uuid        not null,
  created_at     timestamptz not null default now(),
  constraint record_links_pkey primary key (id),
  constraint record_links_tenant_id_key unique (business_id, id),
  constraint record_links_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint record_links_from_fkey foreign key (business_id, from_record_id)
    references public.records (business_id, id),
  constraint record_links_to_fkey foreign key (business_id, to_record_id)
    references public.records (business_id, id),
  constraint record_links_type_present check (link_type ~ '^[a-z][a-z0-9_]{0,62}$'),
  constraint record_links_not_to_itself check (from_record_id <> to_record_id)
);

create unique index record_links_edge_idx
  on public.record_links (business_id, link_type, from_record_id, to_record_id);

-- The reverse direction is read as often as the forward one: "what links to
-- this record" is the subtask count and the relation panel.
create index record_links_to_idx
  on public.record_links (business_id, link_type, to_record_id);

alter table public.record_links enable row level security;
alter table public.record_links force row level security;

create policy tenancy_record_links on public.record_links
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_record_links on public.record_links
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on public.record_links to ops_astro_app;

-- ---------------------------------------------------------------------------
-- Uniqueness.
-- ---------------------------------------------------------------------------

-- Uniqueness is a table written in the record's transaction, never a partial
-- unique index created at runtime (ADR 0030:19). The rows are written by the
-- trigger below rather than by a caller, so uniqueness holds for every entry
-- point including a direct write.
--
-- `canonical_value` is trimmed and lower-cased, and the constraint says so, so
-- "the same value differing by case or surrounding space" is answered by the
-- schema rather than discovered by a person (fixed slots, 5.3 E2).
create table public.record_unique_values (
  business_id     uuid        not null,
  id              uuid        not null,
  record_type_id  uuid        not null,
  field_def_id    uuid        not null,
  record_id       uuid        not null,
  canonical_value text        not null,
  created_at      timestamptz not null default now(),
  constraint record_unique_values_pkey primary key (id),
  constraint record_unique_values_tenant_id_key unique (business_id, id),
  constraint record_unique_values_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint record_unique_values_type_fkey foreign key (business_id, record_type_id)
    references public.record_types (business_id, id),
  constraint record_unique_values_field_fkey foreign key (business_id, field_def_id)
    references public.field_defs (business_id, id),
  constraint record_unique_values_record_fkey foreign key (business_id, record_id)
    references public.records (business_id, id),
  constraint record_unique_values_canonical
    check (canonical_value = lower(btrim(canonical_value)) and canonical_value <> '')
);

-- The claim itself. Two concurrent writes of one value meet here: the second
-- waits on the first and is then refused, rather than both succeeding.
create unique index record_unique_values_claim_idx
  on public.record_unique_values (business_id, record_type_id, field_def_id, canonical_value);

-- One claim per field per record, so a record's claims can be replaced by
-- identity when its data changes.
create unique index record_unique_values_holder_idx
  on public.record_unique_values (business_id, record_id, field_def_id);

alter table public.record_unique_values enable row level security;
alter table public.record_unique_values force row level security;

create policy tenancy_record_unique_values on public.record_unique_values
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_record_unique_values on public.record_unique_values
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on public.record_unique_values to ops_astro_app;

-- ---------------------------------------------------------------------------
-- The slot-and-`data` trigger.
-- ---------------------------------------------------------------------------

-- One trigger keeps the slots, the search vector and the revision in step with
-- `data`, in the same statement as the write (ADR 0030:14).
--
-- It recomputes every slot on every write instead of only the ones that
-- changed. That is deliberate: a field removed from `data` must leave its slot
-- null, a field deactivated must stop projecting, and a slot column written
-- directly must not survive. Recomputing from one source answers all three;
-- diffing answers the first only.
create function public.records_project_slots() returns trigger
  language plpgsql
  as $$
  declare
    projected jsonb;
    searchable_text text;
  begin
    -- Every slot starts null, so a slot no longer assigned to a live field
    -- empties rather than keeping the last value it happened to hold.
    projected := (select jsonb_object_agg(slot, 'null'::jsonb) from ops.slots);

    -- Then the slots this record type has assigned, read out of `data` by the
    -- field's key. `jsonb_populate_record` does the casting, so a value that
    -- cannot be a uuid or a timestamp raises here rather than landing as null
    -- and being filtered on later as though it were absent.
    projected := projected || coalesce(
      (select jsonb_object_agg(f.slot, new.data -> f.key)
         from public.field_defs f
        where f.business_id = new.business_id
          and f.record_type_id = new.record_type_id
          and f.slot is not null
          and f.deactivated_at is null
          and new.data ? f.key),
      '{}'::jsonb);

    new := jsonb_populate_record(new, projected);

    -- Search covers searchable slotted text and nothing else, so a term that
    -- lives only in unsearchable `data` is genuinely not found. Silence that
    -- varies by field is what reads as data loss.
    select coalesce(string_agg(new.data ->> f.key, ' '), '')
      into searchable_text
      from public.field_defs f
     where f.business_id = new.business_id
       and f.record_type_id = new.record_type_id
       and f.searchable
       and f.deactivated_at is null
       and jsonb_typeof(new.data -> f.key) = 'string';

    new.search_tsv := to_tsvector('english', searchable_text);

    -- The revision is the server's, not the caller's. `expected_revision` is
    -- worth nothing if a writer can choose what it will be compared against.
    if tg_op = 'UPDATE' then
      new.revision := old.revision + 1;
      new.updated_at := now();
    else
      new.revision := 1;
      new.updated_at := new.created_at;
    end if;

    return new;
  end;
  $$;

revoke execute on function public.records_project_slots() from public;

create trigger records_immutable
  before update on public.records
  for each row
  execute function public.refuse_immutable_columns('id', 'business_id', 'record_type_id', 'created_at');

create trigger records_project_slots
  before insert or update on public.records
  for each row execute function public.records_project_slots();

-- The uniqueness claims, in the record's own transaction. An AFTER trigger
-- rather than a BEFORE one because the claim rows reference the record, and on
-- an insert the record does not exist yet.
--
-- The claims are replaced wholesale for the same reason the slots are: one
-- source, recomputed, rather than a diff that has to be right about what
-- changed. A trashed record releases its claims, because the default query
-- path hides it and a held value nobody can see is a refusal nobody can
-- explain (fixed slots, 5.3 E3). Restoring re-claims, and if the value was
-- taken meanwhile the restore fails loudly rather than restoring a duplicate.
create function public.records_sync_unique_values() returns trigger
  language plpgsql
  as $$
  begin
    delete from public.record_unique_values
     where business_id = new.business_id and record_id = new.id;

    if new.deleted_at is null then
      insert into public.record_unique_values
        (business_id, id, record_type_id, field_def_id, record_id, canonical_value)
      select new.business_id, gen_random_uuid(), new.record_type_id, f.id, new.id,
             lower(btrim(new.data ->> f.key))
        from public.field_defs f
       where f.business_id = new.business_id
         and f.record_type_id = new.record_type_id
         and f.unique_value
         and f.deactivated_at is null
         and jsonb_typeof(new.data -> f.key) = 'string'
         and btrim(new.data ->> f.key) <> '';
    end if;

    return null;
  end;
  $$;

revoke execute on function public.records_sync_unique_values() from public;

create trigger records_sync_unique_values
  after insert or update on public.records
  for each row execute function public.records_sync_unique_values();
