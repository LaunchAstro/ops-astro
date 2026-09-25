-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0007 the command envelope: the repeat-request register and the audit chain.
--
-- Two tables, and they are the last two of the twenty-eight specification 9.1
-- fixes for the envelope group. Everything else T1f builds is code.
--
-- `operations` answers "have I seen this request before?". `audit_events`
-- answers "what was attempted here, and by whom?" — including the attempts
-- that were refused, which is the clause that makes a deliberate probe visible
-- to an operator even though it is invisible to the prober.
--
-- Both inherit 0001's four rules — `business_id` not null and indexed, row
-- security enabled and forced, one restrictive tenancy policy on the session
-- setting, composite foreign keys — and neither restates them.
--
-- Neither table is granted UPDATE or DELETE. They are the evidence retention
-- class (specification 14.3): never purged, append-only, with the purge
-- operation refusing to name them, which T1e already registered.
--
-- **Neither table carries a foreign key to `records`, and that is the point.**
-- `record_id` and `subject_record_id` are opaque, for the same reason
-- `grants.scope_id` is (0003, and ADR 0012): the record they name is in the
-- work retention class and is purged, while these two are evidence and are
-- never purged. A foreign key would mean one of two things, and both are
-- wrong. Without a cascade the purge fails on the key, which is exactly what
-- happened the first time a purge ran against a task a command had created.
-- With one, purging a record would delete the record of who did what to it,
-- which is the whole thing an audit chain exists to prevent. So the pointer
-- outlives its record, `business_id` is still enforced by the tenancy policy,
-- and a reader that finds no record behind an event is looking at evidence of
-- something that has since been purged rather than at a broken link.

-- ---------------------------------------------------------------------------
-- The repeat-request register.
-- ---------------------------------------------------------------------------

-- One row is one attempt at one operation identity. The row is written whether
-- the attempt applied or was refused, and that is deliberate: T1-N2 requires
-- the same identity with a *different* payload to be refused
-- `OPERATION_ID_REUSED`, and if a refused attempt left no row the second
-- attempt would find nothing to compare against and would be allowed through.
-- So a refusal is a result, it is recorded, and it replays.
--
-- The consequence, stated because it is the cost: a caller who wants a fresh
-- attempt after a refusal presents a fresh identity. Replaying a stale refusal
-- forever would be the alternative, and it is what the register is for.
create table public.operations (
  business_id    uuid        not null,
  id             uuid        not null,

  -- The caller's identity for this request. Text rather than uuid, because a
  -- retry has to present the *same* one, and an identity a client can derive
  -- from the work it is doing is easier to present again than a random uuid it
  -- has to have kept. The shape is constrained so it cannot be a sentence.
  operation_id   text        not null,

  command        text        not null,
  actor_id       uuid        not null,

  -- The digest, never the payload. What made the digest is in the audit event
  -- beside it, under the same identity, and neither holds the payload itself.
  payload_digest text        not null,

  outcome        text        not null,

  -- The original result, so a replay returns what the first attempt returned
  -- rather than doing the work again. A durable handle with its revision, or
  -- the typed refusal object. Neither carries a value the caller supplied.
  result         jsonb       not null,

  record_id      uuid,
  -- `bigint`, matching `records.revision`. An `integer` here would have been a
  -- second opinion about how many times a record can be written.
  revision       bigint,
  created_at     timestamptz not null default now(),

  constraint operations_pkey primary key (id),
  constraint operations_tenant_id_key unique (business_id, id),

  -- The register itself. One identity, one attempt — **per actor**, not per
  -- business. A cross-model review found what the business-wide key cost: the
  -- register is read before authority is checked, because a replay must not do
  -- the work again, so a member with no grant at all who presented a
  -- colleague's `operation_id` and the same payload was handed the
  -- colleague's result. And a different payload under a colleague's identity
  -- answered `OPERATION_ID_REUSED`, which is an oracle for enumerating
  -- identities somebody else derived from their own work.
  --
  -- A repeat-request identity belongs to whoever presented it. Two actors may
  -- now use the same one independently, which is also what makes a natural
  -- identity — `pickup-T-431-attempt-2` — safe to derive.
  constraint operations_identity_key unique (business_id, actor_id, operation_id),

  constraint operations_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint operations_actor_fkey foreign key (business_id, actor_id)
    references public.actors (business_id, id),

  constraint operations_outcome_known check (outcome in ('applied', 'refused')),
  constraint operations_identity_shape check (
    operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
  ),
  constraint operations_command_shape check (command ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint operations_digest_shape check (payload_digest ~ '^[0-9a-f]{64}$'),
  constraint operations_revision_positive check (revision is null or revision >= 1),
  -- A refusal result carries a code and an applied one does not, so the
  -- outcome column and the result cannot disagree about what happened.
  constraint operations_result_matches_outcome check ((outcome = 'refused') = (result ? 'code'))
);

alter table public.operations enable row level security;
alter table public.operations force row level security;

create policy tenancy_operations on public.operations
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

-- The permissive baseline. Authority over an attempt is the command's, checked
-- inside the serving transaction before the row is written; a policy narrowed
-- to the caller's own attempts would hide from an operator exactly the probe
-- the register exists to record.
create policy authority_operations on public.operations
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.operations to ops_astro_app;

-- ---------------------------------------------------------------------------
-- The audit chain.
-- ---------------------------------------------------------------------------

-- One append-only chain per business, its writes serialised by a
-- business-scoped advisory lock (ADR 0039). `seq`, `prev_hash` and `hash` are
-- the server's: a writer that could choose its own position could write itself
-- into the middle of somebody else's history.
--
-- What is *not* here, and the ADR says so itself: there is no signature over
-- the head, no external anchor and no key. The ADR keeps the signing key
-- outside the database and exports head hashes to an immutable target, and
-- records both as unbuilt. A hash chain alone is not proof against an actor
-- who controls the database; it is proof that a row changed after it was
-- written, and that is what the verifier checks.
create table public.audit_events (
  business_id       uuid        not null,
  id                uuid        not null,

  -- The position in this business's chain. Written by the trigger.
  seq               bigint      not null,

  occurred_at       timestamptz not null default now(),
  actor_id          uuid        not null,
  command           text        not null,

  -- Null for an attempt that never reached an operation identity.
  operation_id      text,

  -- `replayed` is an attempt too: a client hammering a retry is a thing an
  -- operator should be able to see. `failed` is an attempt that raised rather
  -- than refusing, and it carries no message, because a message may carry a
  -- value.
  outcome           text        not null,

  -- The register's code, including the ones a caller is never shown.
  refusal_code      text,

  subject_record_id uuid,
  payload_digest    text        not null,

  -- The one place a value the caller supplied is kept, and it is kept on
  -- purpose: T1-N4 sends the attempted value to the audit and not to the
  -- response. Only the offending keys, never the whole payload.
  attempted         jsonb,

  prev_hash         text,
  hash              text        not null,

  constraint audit_events_pkey primary key (id),
  constraint audit_events_tenant_id_key unique (business_id, id),
  constraint audit_events_chain_key unique (business_id, seq),

  constraint audit_events_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint audit_events_actor_fkey foreign key (business_id, actor_id)
    references public.actors (business_id, id),

  constraint audit_events_outcome_known check (
    outcome in ('applied', 'refused', 'replayed', 'failed')
  ),
  constraint audit_events_command_shape check (command ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint audit_events_digest_shape check (payload_digest ~ '^[0-9a-f]{64}$'),
  constraint audit_events_hash_shape check (
    hash ~ '^[0-9a-f]{64}$' and (prev_hash is null or prev_hash ~ '^[0-9a-f]{64}$')
  ),
  -- The first event of a business's chain is the only one with nothing before
  -- it, so a null `prev_hash` anywhere else is a break the schema catches.
  constraint audit_events_first_has_no_parent check ((seq = 1) = (prev_hash is null)),
  constraint audit_events_seq_positive check (seq >= 1),
  -- A refusal names its code. Nothing else may, except a replay, which
  -- returns whatever the first attempt returned.
  constraint audit_events_refusal_has_code check (outcome <> 'refused' or refusal_code is not null),
  constraint audit_events_code_belongs_to_refusal check (
    refusal_code is null or outcome in ('refused', 'replayed')
  ),
  constraint audit_events_attempted_belongs_to_refusal check (
    attempted is null or outcome = 'refused'
  ),
  constraint audit_events_attempted_is_an_object check (
    attempted is null or jsonb_typeof(attempted) = 'object'
  )
);

-- Every read of the chain is by business and position, and so is the verifier.
create index audit_events_chain_idx on public.audit_events (business_id, seq);

-- The two reads an operator makes: what happened to this record, and what did
-- this attempt do.
create index audit_events_subject_idx
  on public.audit_events (business_id, subject_record_id)
  where subject_record_id is not null;
create index audit_events_operation_idx
  on public.audit_events (business_id, operation_id)
  where operation_id is not null;

alter table public.audit_events enable row level security;
alter table public.audit_events force row level security;

create policy tenancy_audit_events on public.audit_events
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_audit_events on public.audit_events
  as permissive
  for all
  using (true)
  with check (true);

-- No UPDATE and no DELETE, which is the evidence class written as a privilege
-- rather than as a promise (specification 14.3, ADR 0039).
grant select, insert on public.audit_events to ops_astro_app;

-- ---------------------------------------------------------------------------
-- The hash, in one place.
-- ---------------------------------------------------------------------------

-- The chain's formula lives in one function so that the trigger that writes a
-- hash and the verifier that checks one cannot drift apart. Two copies of a
-- hash formula is a verifier that agrees with the writer about a chain neither
-- of them computes correctly.
--
-- The timestamp is formatted explicitly rather than cast, because a cast
-- depends on `DateStyle` and a session that changed it would compute a
-- different hash for the same row.
create function public.audit_event_hash(
  prev_hash text,
  business_id uuid,
  seq bigint,
  occurred_at timestamptz,
  actor_id uuid,
  command text,
  operation_id text,
  outcome text,
  refusal_code text,
  subject_record_id uuid,
  payload_digest text,
  attempted jsonb
) returns text
  language sql
  immutable
  as $$
    select encode(sha256(convert_to(
      coalesce(prev_hash, '') || '|' ||
      business_id::text || '|' ||
      seq::text || '|' ||
      to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '|' ||
      actor_id::text || '|' ||
      command || '|' ||
      coalesce(operation_id, '') || '|' ||
      outcome || '|' ||
      coalesce(refusal_code, '') || '|' ||
      coalesce(subject_record_id::text, '') || '|' ||
      payload_digest || '|' ||
      coalesce(attempted::text, ''),
      'utf8')), 'hex')
  $$;

revoke execute on function public.audit_event_hash(
  text, uuid, bigint, timestamptz, uuid, text, text, text, text, uuid, text, jsonb
) from public;
grant execute on function public.audit_event_hash(
  text, uuid, bigint, timestamptz, uuid, text, text, text, text, uuid, text, jsonb
) to ops_astro_app;

-- ---------------------------------------------------------------------------
-- The serialisation point.
-- ---------------------------------------------------------------------------

-- The advisory lock is what ADR 0039 calls the defined ordering point: two
-- concurrent writers to one business's chain take it in turn, so neither reads
-- a head the other is about to replace. It is transaction-scoped, so it is
-- released by the commit that wrote the row and there is nothing to unlock.
--
-- The lock is per business, keyed on the business identifier, so a busy tenant
-- does not serialise a quiet one.
create function public.audit_events_chain() returns trigger
  language plpgsql
  as $$
  declare
    head record;
  begin
    perform pg_advisory_xact_lock(hashtextextended(new.business_id::text, 0));

    select a.seq, a.hash into head
      from public.audit_events a
     where a.business_id = new.business_id
     order by a.seq desc
     limit 1;

    -- The position and the link are the server's, whatever arrived in them.
    new.seq := coalesce(head.seq, 0) + 1;
    new.prev_hash := head.hash;

    new.hash := public.audit_event_hash(
      new.prev_hash, new.business_id, new.seq, new.occurred_at, new.actor_id, new.command,
      new.operation_id, new.outcome, new.refusal_code, new.subject_record_id,
      new.payload_digest, new.attempted);

    return new;
  end;
  $$;

revoke execute on function public.audit_events_chain() from public;

create trigger audit_events_chain
  before insert on public.audit_events
  for each row execute function public.audit_events_chain();

-- Append-only as a property of the table rather than of a grant. The
-- application role has no UPDATE or DELETE privilege, but the owner does, and
-- an evidence class that only holds against callers who were not granted the
-- privilege is an evidence class that holds until the first migration that
-- grants it.
create function public.refuse_append_only() returns trigger
  language plpgsql
  as $$
  begin
    raise exception 'APPEND_ONLY: %.% is append-only evidence and cannot be % ',
      tg_table_schema, tg_table_name, lower(tg_op)
      using errcode = 'restrict_violation';
  end;
  $$;

revoke execute on function public.refuse_append_only() from public;

create trigger audit_append_only
  before update or delete on public.audit_events
  for each row execute function public.refuse_append_only();

create trigger operations_append_only
  before update or delete on public.operations
  for each row execute function public.refuse_append_only();
