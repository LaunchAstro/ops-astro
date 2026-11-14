-- #2370 (ORCH-2114-AUDIT condition 1): a one-snapshot read's audit row names when its snapshot
-- was taken. `task.read` answers from one repeatable read snapshot and writes its audit row
-- afterwards, in a transaction of its own, so `occurred_at` (that later transaction's time,
-- the chain's own order) is a moment after the answer. `served_at` is the snapshot
-- transaction's time, written only on a `task.read` row: a finite time no later than the row
-- itself and within a day before it.
--
-- The hash takes `served_at` only when it is set, after every earlier field, so every row
-- written before this migration, and every row without one, hashes exactly as it did. It is
-- spelled exactly: the UTC clock reading to the microsecond with every digit of its year and
-- its era, and an infinite time by its name, so no two times Postgres can store spell alike
-- (seconds since the epoch would round far from it; a reading without its era would spell
-- the same time in two eras alike; `to_char` spells an infinite time as nothing at all).

alter table public.audit_events
  add column served_at timestamptz,
  add constraint audit_events_served_at_shape check (
    served_at is null or (
      command = 'task.read'
      and isfinite(served_at)
      and served_at <= occurred_at
      and served_at >= occurred_at - interval '1 day'
    )
  );

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
  field_changes jsonb,
  served_at timestamptz default null
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
      coalesce('|field_changes_v1:' || field_changes::text, '') ||
      coalesce('|served_at_v1:' || case
        when isfinite(served_at)
          then to_char(served_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US BC')
        else served_at::text
      end, ''),
      'utf8')), 'hex')
  $$;

revoke execute on function public.audit_event_hash(
  text, uuid, bigint, timestamptz, uuid, text, text, text, text, uuid, text, jsonb, uuid, jsonb,
  timestamptz
) from public;
grant execute on function public.audit_event_hash(
  text, uuid, bigint, timestamptz, uuid, text, text, text, text, uuid, text, jsonb, uuid, jsonb,
  timestamptz
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
      new.payload_digest, new.attempted, new.origin_conversation_id, new.field_changes,
      new.served_at);

    return new;
  end;
  $$;

-- The fourteen-field function goes; a call naming fourteen fields now reaches the one above
-- with no snapshot time, which hashes as the old one did.
drop function public.audit_event_hash(
  text, uuid, bigint, timestamptz, uuid, text, text, text, text, uuid, text, jsonb, uuid, jsonb
);
