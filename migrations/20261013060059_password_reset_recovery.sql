-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Password reset on the login provider's one-time recovery session.
--
-- The admin-key password set (20261005144947's token, ORCH77-C40B) is gone:
-- the person's browser writes the password straight to the provider on the
-- recovery session a mailed link opens, and no product code writes one. Its
-- token table and lookup are dropped here. The reset window
-- (`ops.subject_resets`) stays: `begin` opens one before the browser's write,
-- and it ends every session of the login, in every business, until it
-- settles and up to its bound while open.
--
-- Every row here is installation-wide and names no business, person or
-- login: a reset arrives with no business, and a tenant transaction cannot
-- see past its own. The application reaches the request and link rows only
-- through narrow security definer functions, each revoked from PUBLIC.
--
-- 1. `ops.password_reset_requests`: a request for a link, owed until the M5
--    unit sends it, drops it or holds it for support. The application group
--    asks through `ops.password_reset_request(address, caller)` alone: under
--    advisory locks on the address's digest and then the caller's, held to
--    commit, it counts the hour's rows for each and inserts only with room,
--    3 per address and 10 per caller. Over a limit, or for no address at all,
--    it inserts nothing and answers the same, so the statements and the
--    answer are the same for every input. The unit's grants come with its own
--    change.
-- 2. `ops.recovery_links`: a recovery link the unit minted and mailed, by
--    subject digest, with the provider's own `recovery_sent_at` for that mint
--    as its `generate_link` answered it; never the link, its hash or the
--    address. The unit's insert grant comes with its own change. The
--    application group consumes one through
--    `ops.recovery_link_consume(subject, at, sent)`: the newest unconsumed
--    link of the subject minted inside the provider's link lifetime (1,800
--    seconds), no later than `at`, the recovery session's sign-in second, and
--    whose provider mint is `sent`, the provider's `recovery_sent_at` as the
--    session reads it now. The provider keeps one such link a login, and a
--    sign-in link minted after ours replaces it and moves `recovery_sent_at`,
--    so a session no link of ours opened finds none: the provider's tokens and
--    its user say nothing else that tells the two apart.
-- 3. `ops.recovery_resets`: one reset window per recovery session, by the
--    session's digest. `begin` inserts it with its window and `write_until`,
--    the recovery token's expiry as `begin` saw it, a record only: a refresh
--    of the session outlives it, so it bounds nothing; `changed` settles it
--    once (the trigger), so a second `begin` on the
--    session is the same window and a second `changed` settles nothing and
--    audits nothing.
-- 4. `ops.recovery_subject_business(subject)`: the first business, by id,
--    where the subject is a provider login mapped live to an active member
--    with an active acting identity, its access not ended; null for none.
--    `begin` refuses a login mapped nowhere; `changed` audits there.
-- 5. `ops.reset_write_open(subject, signed_in)`: whether a session of the
--    login first signed in after an unsettled window's bound could still be
--    outlived by that window's password write. Its recovery session can write
--    for as long as the provider keeps it, refreshed or not, and that life is
--    not visible here; a write deletes every other session of the login at
--    the provider and nothing here. So it holds until a later reset of the
--    login settles: that reset's own write, after its window opened, deleted
--    the earlier recovery session at the provider. The door asks the provider about
--    such a session (`sessionRefusal`); `ops.session_refusal` refuses it for
--    the carriage join, which has no provider to ask (`judge_limit`).

drop function public.password_reset_token_find(text);
drop table public.password_reset_tokens;

create table ops.password_reset_requests (
  id            uuid        primary key,
  -- Lower case, trimmed, one `@`, at most 320 characters.
  address       text        not null
    check (address = lower(btrim(address)) and length(address) <= 320
           and address ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  caller_digest text        not null check (caller_digest ~ '^[0-9a-f]{64}$'),
  requested_at  timestamptz not null default clock_timestamp(),
  state         text        not null default 'owed'
    check (state in ('owed', 'sent', 'dropped', 'needs_support')),
  settled_at    timestamptz,
  constraint password_reset_requests_settled check ((state = 'owed') = (settled_at is null))
);
create index password_reset_requests_address
  on ops.password_reset_requests (address, requested_at);
create index password_reset_requests_caller
  on ops.password_reset_requests (caller_digest, requested_at);
create index password_reset_requests_owed
  on ops.password_reset_requests (requested_at) where state = 'owed';
revoke all on ops.password_reset_requests from public;

create function ops.password_reset_request(address text, caller text)
  returns void
  language plpgsql
  security definer
  set search_path = pg_catalog
as $$
declare
  asked     text := lower(btrim(coalesce(address, '')));
  by_caller text := encode(sha256(convert_to(coalesce(caller, ''), 'UTF8')), 'hex');
  room      boolean;
begin
  -- The address first, then the caller, each held to commit: a request at
  -- once waits here, then counts what the one before it inserted.
  perform pg_advisory_xact_lock(hashtextextended(
    'reset:address:' || encode(sha256(convert_to(asked, 'UTF8')), 'hex'), 0));
  perform pg_advisory_xact_lock(hashtextextended('reset:caller:' || by_caller, 0));
  select (select count(*) from ops.password_reset_requests r
           where r.address = asked
             and r.requested_at > clock_timestamp() - interval '1 hour') < 3
     and (select count(*) from ops.password_reset_requests r
           where r.caller_digest = by_caller
             and r.requested_at > clock_timestamp() - interval '1 hour') < 10
    into room;
  insert into ops.password_reset_requests (id, address, caller_digest)
  select gen_random_uuid(), asked, by_caller
   where room and length(asked) <= 320 and asked ~ '^[^@[:space:]]+@[^@[:space:]]+$';
end;
$$;
revoke all on function ops.password_reset_request(text, text) from public;
grant execute on function ops.password_reset_request(text, text) to ops_astro_app;

create table ops.recovery_links (
  id             uuid        primary key,
  subject_digest text        not null check (subject_digest ~ '^[0-9a-f]{64}$'),
  minted_at      timestamptz not null default clock_timestamp(),
  provider_sent_at timestamptz not null,
  consumed_at    timestamptz
);
create index recovery_links_subject on ops.recovery_links (subject_digest, minted_at);
revoke all on ops.recovery_links from public;

create function ops.recovery_link_consume(subject text, at timestamptz, sent timestamptz)
  returns boolean
  language sql
  security definer
  set search_path = pg_catalog
as $$
  with chosen as (
    select l.id from ops.recovery_links l
     where l.subject_digest = encode(sha256(convert_to(subject, 'UTF8')), 'hex')
       and l.consumed_at is null
       and l.minted_at > clock_timestamp() - interval '1800 seconds'
       and date_trunc('second', l.minted_at) <= at
       -- The provider answers in nanoseconds and keeps microseconds.
       and l.provider_sent_at between sent - interval '1 millisecond'
                                  and sent + interval '1 millisecond'
     order by l.minted_at desc, l.id
     limit 1
       for update),
  consumed as (
    update ops.recovery_links l set consumed_at = clock_timestamp()
      from chosen where l.id = chosen.id
    returning 1)
  select exists (select 1 from consumed)
$$;
revoke all on function ops.recovery_link_consume(text, timestamptz, timestamptz) from public;
grant execute on function ops.recovery_link_consume(text, timestamptz, timestamptz)
  to ops_astro_app;

create table ops.recovery_resets (
  session_digest text        primary key check (session_digest ~ '^[0-9a-f]{64}$'),
  reset_id       uuid        not null unique references ops.subject_resets (id),
  opened_at      timestamptz not null default clock_timestamp(),
  write_until    timestamptz not null,
  settled_at     timestamptz
);
revoke all on ops.recovery_resets from public;
grant select (session_digest, reset_id, opened_at, write_until, settled_at),
  insert (session_digest, reset_id, write_until), update (settled_at)
  on ops.recovery_resets to ops_astro_app;

-- A window settles once, at the database's own moment, as `ops.subject_resets` does.
create function ops.recovery_resets_settle_once()
  returns trigger
  language plpgsql
  set search_path = pg_catalog
as $$
begin
  if old.settled_at is not null then
    raise exception 'recovery_resets: this reset is already settled';
  end if;
  if (new.session_digest, new.reset_id, new.opened_at, new.write_until)
       is distinct from (old.session_digest, old.reset_id, old.opened_at, old.write_until) then
    raise exception 'recovery_resets: a reset changes only by settling';
  end if;
  new.settled_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function ops.recovery_resets_settle_once() from public;

create trigger recovery_resets_settle_once
  before update on ops.recovery_resets
  for each row execute function ops.recovery_resets_settle_once();

create function ops.recovery_subject_business(subject text)
  returns uuid
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  set row_security = off
as $$
  select l.business_id
    from public.logins l
    join public.person_logins pl
      on pl.business_id = l.business_id and pl.login_id = l.id and pl.active
    join public.memberships m
      on m.business_id = pl.business_id and m.person_id = pl.person_id and m.active
    join public.actors a
      on a.business_id = pl.business_id and a.person_id = pl.person_id
     and a.kind = 'person' and a.active
   where l.provider = 'supabase' and l.subject = recovery_subject_business.subject
     and not exists (
       select 1 from public.access_endings e
        where e.business_id = l.business_id and e.login_id = l.id)
   order by l.business_id
   limit 1
$$;
revoke all on function ops.recovery_subject_business(text) from public;
grant execute on function ops.recovery_subject_business(text) to ops_astro_app;

create function ops.reset_write_open(subject text, signed_in bigint)
  returns boolean
  language sql
  stable
  set search_path = pg_catalog
as $$
  select exists (
    select 1 from ops.recovery_resets w
      join ops.subject_resets r on r.id = w.reset_id
     where r.subject_digest = encode(sha256(convert_to(subject, 'UTF8')), 'hex')
       and r.settled_at is null
       and to_timestamp(signed_in) > r.open_until
       and not exists (
         select 1 from ops.subject_resets later
          where later.subject_digest = r.subject_digest
            and later.settled_at is not null and later.open_until > r.open_until))
$$;
revoke all on function ops.reset_write_open(text, bigint) from public;
grant execute on function ops.reset_write_open(text, bigint) to ops_astro_app;

-- 20261013044500's rule, and one more for a caller with no provider to ask
-- (`judge_limit`, the carriage join): a session `ops.reset_write_open` names
-- is refused, where the door asks the provider instead.
create or replace function ops.session_refusal(
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
      when judge_limit and session is not null and ops.reset_write_open(subject, signed_in)
        then 'AUTH_SESSION_EXPIRED'
      when factor_asked and not aal2 and cardinality(ops.login_verified_factors(subject)) > 0
        then 'AUTH_SECOND_FACTOR_REQUIRED'
    end
  $$;
