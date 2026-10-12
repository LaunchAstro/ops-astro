-- SPDX-License-Identifier: AGPL-3.0-only
--
-- An agent credential lives at most 90 days from its issue
-- (`CREDENTIAL_MAX_DAYS`, `authority/agent-credentials.ts`). `credential.issue`
-- judges that on the database clock that stamps `issued_at`; this holds it
-- in the database too, so no row written any other way lives longer.
--
-- A trigger on insert rather than a check constraint: rows issued before
-- this were judged on the app clock and may run a few milliseconds past the
-- ceiling, and a check would refuse their revocation, the one update a row
-- takes. `agent_credentials_written_once` keeps both times as inserted.

create function public.agent_credentials_within_ceiling() returns trigger
  language plpgsql
  as $$
  begin
    if new.expires_at > new.issued_at + interval '90 days' then
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
