-- SPDX-License-Identifier: AGPL-3.0-only
--
-- An agent credential lives at most 90 days of 24 hours from its issue
-- (`CREDENTIAL_MAX_DAYS`, `authority/agent-credentials.ts`). `credential.issue`
-- judges that on the database clock that stamps `issued_at`; this holds it in
-- the database too. A row may not claim an issue later than the database's
-- clock as it is inserted, so no writer can start the 90 days in the future,
-- and the ceiling is in hours, not calendar days, so a session time zone with
-- summer time neither stretches nor shrinks it. A restored row keeps its own
-- past issue and passes.
--
-- A trigger on insert rather than a check constraint: rows issued before
-- this were judged on the app clock and may run a few milliseconds past the
-- ceiling, and a check would refuse their revocation, the one update a row
-- takes. `agent_credentials_written_once` keeps both times as inserted.

create function public.agent_credentials_within_ceiling() returns trigger
  language plpgsql
  as $$
  begin
    if new.issued_at > clock_timestamp() then
      raise exception 'agent_credentials: an agent credential cannot be issued in the future, which would start its 90 days late'
        using errcode = 'check_violation', constraint = 'agent_credentials_within_ceiling';
    end if;
    if new.expires_at > new.issued_at + interval '2160 hours' then
      raise exception 'agent_credentials: an agent credential lives at most 90 days from its issue'
        using errcode = 'check_violation', constraint = 'agent_credentials_within_ceiling';
    end if;
    return new;
  end;
  $$;

revoke execute on function public.agent_credentials_within_ceiling() from public;

create trigger agent_credentials_within_ceiling
  before insert on public.agent_credentials
  for each row execute function public.agent_credentials_within_ceiling();
