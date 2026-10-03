-- SPDX-License-Identifier: AGPL-3.0-only
-- A UTC timestamp ID (docs/local/DATA.md, "What the schema is").
--
-- 20261003024319 other sessions ended at commit (C58, Sol OW-001-FIX2).
-- 0063's `ended_before` defaults to now(), the ending transaction's start.
-- Login resolution refuses a session of the subject whose first sign-in is at
-- or before that time (plus the provider's minute of clock), so an ending
-- whose transaction waited, on a lock or anything else, left a session
-- signed in during the wait served in every other business after the ending
-- committed. The ending now takes its time at commit: a deferred constraint
-- trigger sets the new row's `ended_before` to the clock as the transaction
-- commits. A session signed in before then is ended; one signed in after is
-- not.
--
-- Who may do what. The application group still inserts the digest and the
-- kept session and reads the three columns (0063); it updates nothing, so it
-- cannot move an ending's time. The trigger's function is a security definer
-- so its one update reaches the row the group cannot update, pinned to
-- pg_catalog, never executed by PUBLIC, and fired by nothing but this insert.
-- It only moves the time later.

create function ops.ended_subject_sessions_at_commit() returns trigger
  language plpgsql security definer set search_path = pg_catalog as $$
begin
  update ops.ended_subject_sessions s
     set ended_before = greatest(s.ended_before, clock_timestamp())
   where s.subject_digest = new.subject_digest
     and s.kept_session is not distinct from new.kept_session
     and s.ended_before = new.ended_before;
  return null;
end;
$$;
revoke execute on function ops.ended_subject_sessions_at_commit() from public;

create constraint trigger ended_subject_sessions_at_commit
  after insert on ops.ended_subject_sessions
  deferrable initially deferred
  for each row
  execute function ops.ended_subject_sessions_at_commit();
