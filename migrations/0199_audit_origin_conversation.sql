-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0050 the conversation that created a task, on its creation audit event (AW-03).
--
-- The task carries no conversation column (0049): which conversation created
-- a task is a fact of the task's creation audit event. The audit event held
-- only a digest of the payload, so the fact gets a column of its own there:
-- `origin_conversation_id`, nullable, naming a conversation of the event's
-- own business. The command that creates a task from a conversation sets it;
-- nothing else does.
--
-- The chain's one hash formula reads it. A null origin adds nothing to the
-- hashed text, so every event written before this migration, and every event
-- without an origin after it, hashes exactly as 0007's formula did and the
-- chain verifies unchanged. A present origin appends `|origin_conversation:`
-- and its identifier after `attempted`, which is either empty or a JSON
-- object's text (`audit_events_attempted_is_an_object`) and so never ends
-- the way the appended part does: no two events hash from the same text.
--
-- One formula still: the twelve-argument function is replaced by the
-- thirteen-argument one, the trigger calls it, and the old one is dropped so
-- no second copy can drift.

alter table public.audit_events
  add column origin_conversation_id uuid;

alter table public.audit_events
  add constraint audit_events_origin_conversation_fkey
    foreign key (business_id, origin_conversation_id)
    references public.conversations (business_id, id);

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
  origin_conversation_id uuid
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
      coalesce('|origin_conversation:' || origin_conversation_id::text, ''),
      'utf8')), 'hex')
  $$;

revoke execute on function public.audit_event_hash(
  text, uuid, bigint, timestamptz, uuid, text, text, text, text, uuid, text, jsonb, uuid
) from public;
grant execute on function public.audit_event_hash(
  text, uuid, bigint, timestamptz, uuid, text, text, text, text, uuid, text, jsonb, uuid
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
      new.payload_digest, new.attempted, new.origin_conversation_id);

    return new;
  end;
  $$;

drop function public.audit_event_hash(
  text, uuid, bigint, timestamptz, uuid, text, text, text, text, uuid, text, jsonb
);
