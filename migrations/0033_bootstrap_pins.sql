-- SPDX-License-Identifier: AGPL-3.0-only
--
-- AW-02: skill instruction files pinned by digest. Three stores, and no
-- activation: the plan accept (AW-04) is the only thing that ever writes a pin.
--
-- A file's identity is its digest and its size. The path is provenance only,
-- so new bytes at an old path are a new file, and the same bytes at two paths
-- are one file.
--
--   run_definition_pins  the run's definition reference slot, one per run. A
--                        bootstrap file today (`bootstrap_file`); a definition
--                        version later (C33, U36), in the same slot, so the
--                        cutover changes the kind future runs carry and never
--                        the mechanism. The accept-time manifest (every
--                        instruction file the run may read, by path, digest
--                        and size) is captured with the pin.
--   bootstrap_reads      the read ledger. Every instruction read a run makes,
--                        entry and non-entry, is one row, written by the read
--                        itself in the transaction that returns the bytes.
--   bootstrap_bytes      the audit copy: every distinct file's bytes, kept
--                        where no run role can read them. It answers "were
--                        these the bytes" for an audit and nothing else.
--
-- Nothing here is ever rewritten. The application group may insert and read
-- a pin and a ledger row and may never update or delete one; it may insert an
-- audit copy and may never read, update or delete one. The worker and broker
-- roles hold nothing on any of them. The number is placed by the rebase onto
-- main (build-ahead).

create table public.run_definition_pins (
  business_id           uuid        not null,
  run_id                uuid        not null,
  ref_kind              text        not null,
  -- bootstrap_file: the entry file, as read at `read_at`.
  path                  text,
  content_digest        text        not null,
  content_size          bigint      not null,
  read_at               timestamptz,
  -- definition_version: the version pinned (C33 adds its foreign key).
  definition_version_id uuid,
  -- The accept-time manifest: [{path, digest, size}], sorted by path, and
  -- the SHA-256 over its lines.
  manifest              jsonb       not null,
  manifest_digest       text        not null,
  pinned_by_actor_id    uuid        not null,
  pinned_at             timestamptz not null default now(),
  constraint run_definition_pins_pkey primary key (business_id, run_id),
  constraint run_definition_pins_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint run_definition_pins_run_fkey foreign key (business_id, run_id)
    references public.planned_runs (business_id, id),
  constraint run_definition_pins_actor_fkey foreign key (business_id, pinned_by_actor_id)
    references public.actors (business_id, id),
  constraint run_definition_pins_kind_known
    check (ref_kind in ('bootstrap_file', 'definition_version')),
  constraint run_definition_pins_bootstrap_shape check (
    ref_kind <> 'bootstrap_file'
    or (path is not null and read_at is not null and definition_version_id is null)
  ),
  constraint run_definition_pins_version_shape check (
    ref_kind <> 'definition_version'
    or (definition_version_id is not null and path is null and read_at is null)
  ),
  constraint run_definition_pins_path_shape check (
    path is null or (path ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$' and path !~ '(^|/)\.\.?(/|$)')
  ),
  constraint run_definition_pins_digest_shape check (content_digest ~ '^[0-9a-f]{64}$'),
  constraint run_definition_pins_size_known check (content_size >= 0),
  constraint run_definition_pins_manifest_shape check (jsonb_typeof(manifest) = 'array'),
  constraint run_definition_pins_manifest_digest_shape check (manifest_digest ~ '^[0-9a-f]{64}$')
);

alter table public.run_definition_pins enable row level security;
alter table public.run_definition_pins force row level security;

create policy tenancy_run_definition_pins on public.run_definition_pins
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_run_definition_pins on public.run_definition_pins
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.run_definition_pins to ops_astro_app;


create table public.bootstrap_reads (
  business_id    uuid        not null,
  id             uuid        not null,
  run_id         uuid        not null,
  -- The step the read happened in; none for the entry read before the first.
  step_id        uuid,
  sequence       integer     not null,
  path           text        not null,
  content_digest text        not null,
  content_size   bigint      not null,
  read_at        timestamptz not null default now(),
  is_entry       boolean     not null,
  constraint bootstrap_reads_pkey primary key (id),
  constraint bootstrap_reads_tenant_id_key unique (business_id, id),
  constraint bootstrap_reads_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  -- No read without a pin: the ledger hangs off the run's pin, not the run.
  constraint bootstrap_reads_pin_fkey foreign key (business_id, run_id)
    references public.run_definition_pins (business_id, run_id),
  constraint bootstrap_reads_step_fkey foreign key (business_id, step_id)
    references public.planned_steps (business_id, id),
  constraint bootstrap_reads_sequence_ordered check (sequence >= 1),
  constraint bootstrap_reads_path_shape
    check (path ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$' and path !~ '(^|/)\.\.?(/|$)'),
  constraint bootstrap_reads_digest_shape check (content_digest ~ '^[0-9a-f]{64}$'),
  constraint bootstrap_reads_size_known check (content_size >= 0)
);

create unique index bootstrap_reads_sequence_idx
  on public.bootstrap_reads (business_id, run_id, sequence);

-- Exactly one entry read per run: the file the pin names.
create unique index bootstrap_reads_one_entry_idx
  on public.bootstrap_reads (business_id, run_id) where is_entry;

alter table public.bootstrap_reads enable row level security;
alter table public.bootstrap_reads force row level security;

create policy tenancy_bootstrap_reads on public.bootstrap_reads
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_bootstrap_reads on public.bootstrap_reads
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.bootstrap_reads to ops_astro_app;


-- The audit copy. Keyed by business and digest: a client's instruction file
-- may hold that client's material, so one business's copy is never another's.
-- The bytes are checked against their own digest and size by the server, so a
-- copy that is not the file it claims to be cannot be stored.
create table public.bootstrap_bytes (
  business_id    uuid        not null,
  content_digest text        not null,
  content_size   bigint      not null,
  bytes          bytea       not null,
  retained_at    timestamptz not null default now(),
  constraint bootstrap_bytes_pkey primary key (business_id, content_digest),
  constraint bootstrap_bytes_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint bootstrap_bytes_digest_shape check (content_digest ~ '^[0-9a-f]{64}$'),
  constraint bootstrap_bytes_are_the_file check (
    octet_length(bytes) = content_size
    and encode(sha256(bytes), 'hex') = content_digest
  )
);

alter table public.bootstrap_bytes enable row level security;
alter table public.bootstrap_bytes force row level security;

create policy tenancy_bootstrap_bytes on public.bootstrap_bytes
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_bootstrap_bytes on public.bootstrap_bytes
  as permissive
  for all
  using (true)
  with check (true);

-- Insert only: a run role keeps the copy and can never read it back.
grant insert on public.bootstrap_bytes to ops_astro_app;
