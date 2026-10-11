-- SPDX-License-Identifier: AGPL-3.0-only
--
-- P20 (U115): the names of the task fields an applied command actually changed,
-- on its own audit event, written in the command's transaction.
--
-- `audit_events.field_changes` holds `{"version": 1, "keys": [...]}`: the
-- top-level data keys whose stored value differs after the write, sorted and
-- distinct. Names only: no old or new value and nothing of the request body.
-- `[]` says the write changed nothing. NULL says nothing is known, which is
-- every event written before this migration and every command that does not
-- record its keys yet; no existing event is backfilled or rewritten.
--
-- The keys come from the database, not from the request: the writer compares
-- the stored data before and after its update (`record_changed_field_keys`),
-- so a field sent with its current value is not a change, and a clear the
-- write causes is one.
--
-- The constraint lists every command that owns a task field. Only `task.update`
-- records its keys in this migration; the others record theirs as each writer
-- is changed (P21), with no further schema change. A listed command that does
-- not record yet writes NULL, which the constraint allows.
--
-- The chain's one hash formula reads the column. NULL adds nothing to the
-- hashed text, so every earlier event hashes exactly as 0093's formula did and
-- the chain verifies unchanged. A present value appends `|field_changes_v1:`
-- and its jsonb text after the origin. The thirteen-argument function is
-- replaced by the fourteen-argument one, the trigger calls it, and the old one
-- is dropped so no second copy can drift.

alter table public.audit_events add column field_changes jsonb;

-- Missing and JSON null both mean empty; key order inside the object is not a change.
create function public.record_changed_field_keys(before_data jsonb, after_data jsonb)
returns text[] language sql immutable as $$
  select coalesce(array_agg(k order by k collate "C"), '{}'::text[])
    from (
      select jsonb_object_keys(coalesce(before_data, '{}'::jsonb)) as k
      union
      select jsonb_object_keys(coalesce(after_data, '{}'::jsonb)) as k
    ) keys
   where coalesce(before_data -> k, 'null'::jsonb)
     is distinct from coalesce(after_data -> k, 'null'::jsonb)
$$;

revoke execute on function public.record_changed_field_keys(jsonb, jsonb) from public;
grant execute on function public.record_changed_field_keys(jsonb, jsonb) to ops_astro_app;

-- The exact shape: two members, version 1, and field keys in the field
-- grammar (0004), each once, in C order. Every branch answers true or false,
-- so a malformed value cannot pass the check as unknown.
create function public.audit_field_changes_valid(changes jsonb)
returns boolean language plpgsql immutable as $$
declare
  member jsonb;
  key text;
  previous text;
begin
  if jsonb_typeof(changes) is distinct from 'object' then return false; end if;
  if (select count(*) from jsonb_object_keys(changes)) <> 2
     or changes -> 'version' is distinct from '1'::jsonb
     or jsonb_typeof(changes -> 'keys') is distinct from 'array'
  then return false; end if;
  for member in select value from jsonb_array_elements(changes -> 'keys') loop
    if jsonb_typeof(member) is distinct from 'string' then return false; end if;
    key := member #>> '{}';
    if key !~ '^[a-z][a-z0-9_]{0,62}$' then return false; end if;
    if previous is not null and previous collate "C" >= key collate "C" then return false; end if;
    previous := key;
  end loop;
  return true;
end;
$$;

revoke execute on function public.audit_field_changes_valid(jsonb) from public;
grant execute on function public.audit_field_changes_valid(jsonb) to ops_astro_app;

alter table public.audit_events add constraint audit_events_field_changes_supported
check (field_changes is null or (
  outcome = 'applied'
  and command in (
    'task.update',
    'task.assign',
    'task.set_stage',
    'task.set_party',
    'task.set_scores',
    'task.set_adhoc',
    'task.set_category',
    'task.triage',
    'task.set_audience',
    'map.scope',
    'task.start',
    'task.complete',
    'task.reopen',
    'task.cancel',
    'task.restart',
    'task.set_state',
    'task.move',
    'task.reparent',
    'task.rank',
    'task.set_type',
    'task.claim',
    'task.set_blocking',
    'task.resolve',
    'task.close_out_of_scope'
  )
  and public.audit_field_changes_valid(field_changes)
));

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
  attempted jsonb,
  origin_conversation_id uuid,
  field_changes jsonb
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
      coalesce(attempted::text, '') ||
      coalesce('|origin_conversation:' || origin_conversation_id::text, '') ||
      coalesce('|field_changes_v1:' || field_changes::text, ''),
      'utf8')), 'hex')
  $$;

revoke execute on function public.audit_event_hash(
  text, uuid, bigint, timestamptz, uuid, text, text, text, text, uuid, text, jsonb, uuid, jsonb
) from public;
grant execute on function public.audit_event_hash(
  text, uuid, bigint, timestamptz, uuid, text, text, text, text, uuid, text, jsonb, uuid, jsonb
) to ops_astro_app;

create or replace function public.audit_events_chain() returns trigger
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
      new.payload_digest, new.attempted, new.origin_conversation_id, new.field_changes);

    return new;
  end;
  $$;

drop function public.audit_event_hash(
  text, uuid, bigint, timestamptz, uuid, text, text, text, text, uuid, text, jsonb, uuid
);
