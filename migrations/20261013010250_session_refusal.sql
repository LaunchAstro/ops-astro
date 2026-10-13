-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The sign-in rules a session is judged by (#1531), in one place: login
-- resolution (`standingOf`, `sessionEnded`, `loginVerifiedFactors`) and the
-- carriage join both ask these, so neither keeps a copy. The two queries are
-- the ones those functions sent, moved as they were; `$n` are their
-- parameters in the same order.

-- Whether the token's session has ended, and whether a reset of its login is
-- open now (`sessionEnded`, C58, C40, 0061, 0063).
create function ops.session_ended(session uuid, subject text, signed_in bigint, skew integer)
  returns table (ended boolean, open boolean)
  language sql
  stable
  set search_path = pg_catalog
  as $$
    with reset as (
       select (to_timestamp($3::bigint) <= r.open_until and r.settled_at is null) as open,
              to_timestamp($3::bigint + 1) <= r.settled_at as settled
         from ops.subject_resets r
        where r.subject_digest = encode(sha256(convert_to($2, 'UTF8')), 'hex'))
     select exists (
       select 1 from ops.ended_provider_sessions where session_id = $1::uuid
     ) or exists (
       select 1 from ops.ended_subject_sessions s
        where s.subject_digest = encode(sha256(convert_to($2, 'UTF8')), 'hex')
          and s.kept_session is distinct from $1::uuid
          and to_timestamp($3::bigint) <= s.ended_before + make_interval(secs => $4)
     ) or exists (select 1 from reset where open or settled) as ended,
     exists (select 1 from reset where open) as open
  $$;

-- The login's factors verified, and not removed, through any business (0064).
create function ops.login_verified_factors(subject text)
  returns setof text
  language sql
  stable
  set search_path = pg_catalog
  as $$
    select distinct v.factor_digest from ops.second_factor_subjects v
      where v.subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex') and v.state = 'verified'
        and not exists (
          select 1 from ops.second_factor_subjects r
           where r.subject_digest = v.subject_digest and r.factor_digest = v.factor_digest
             and r.state = 'removed')
  $$;

-- Why the session is refused, or null: past the 12 hours from its first
-- sign-in or a minute ahead of this clock (`SESSION_ABSOLUTE_SECONDS`,
-- `SIGN_IN_CLOCK_SKEW_SECONDS`), when `judge_limit` (the API's verifier judges
-- that before the database); ended; or stopped at the password for a login
-- with a verified factor, when `factor_asked`. In that order, as `standingOf`.
create function ops.session_refusal(
  subject text, session uuid, signed_in bigint, aal2 boolean, factor_asked boolean,
  judge_limit boolean)
  returns text
  language sql
  stable
  set search_path = pg_catalog
  as $$
    select case
      when judge_limit and (signed_in is null
             or extract(epoch from clock_timestamp()) - signed_in > 43200
             or extract(epoch from clock_timestamp()) - signed_in < -60)
        then 'AUTH_SESSION_EXPIRED'
      when session is not null
           and (select e.ended from ops.session_ended(session, subject, signed_in, 60) e)
        then 'AUTH_SESSION_EXPIRED'
      when factor_asked and not aal2 and exists (select 1 from ops.login_verified_factors(subject))
        then 'AUTH_SECOND_FACTOR_REQUIRED'
    end
  $$;

revoke all on function ops.session_ended(uuid, text, bigint, integer) from public;
revoke all on function ops.login_verified_factors(text) from public;
revoke all on function ops.session_refusal(text, uuid, bigint, boolean, boolean, boolean) from public;
grant execute on function ops.session_ended(uuid, text, bigint, integer) to ops_astro_app;
grant execute on function ops.login_verified_factors(text) to ops_astro_app;
grant execute on function ops.session_refusal(text, uuid, bigint, boolean, boolean, boolean)
  to ops_astro_app;
