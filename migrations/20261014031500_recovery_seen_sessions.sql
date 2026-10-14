-- SPDX-License-Identifier: AGPL-3.0-only
-- A successful reset retires sessions seen in every business, including a
-- business the login's mapping left during the provider write. The subject's
-- ending lock is held by settlePasswordReset. No business or person is returned.
-- The settle's whole second stays available for fresh password sign-ins.

create function ops.recovery_sessions_end(reset uuid)
  returns void
  language sql
  security definer
  set search_path = pg_catalog
  set row_security = off
as $$
  insert into ops.ended_provider_sessions (session_id)
  select distinct a.session_id
    from ops.subject_resets s
    join ops.recovery_resets r on r.reset_id = s.id
    join public.logins l
      on l.provider = 'supabase'
     and encode(sha256(convert_to(l.subject, 'UTF8')), 'hex') = s.subject_digest
    join public.authentication_attempts a
      on a.business_id = l.business_id and a.login_id = l.id
   where s.id = recovery_sessions_end.reset
     and s.settled_at is not null and r.settled_at is not null
     and a.outcome = 'resolved' and a.session_id is not null
     and a.at < date_trunc('second', s.settled_at)
   order by a.session_id
  on conflict (session_id) do nothing;
$$;
revoke all on function ops.recovery_sessions_end(uuid) from public;
grant execute on function ops.recovery_sessions_end(uuid) to ops_astro_app;
