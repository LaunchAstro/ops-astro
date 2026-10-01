-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0069 other sessions ended in every business (C58, ORCH47). A person ending
-- their other sessions (or changing a second factor) ends every session of
-- their sign-in login but the one they keep, in every business the login
-- reaches, including sessions this business never saw.
--
-- One row per ending: the login's subject as a SHA-256 digest, the session
-- kept (null keeps none) and when. Login resolution refuses a token of that
-- subject whose session is not the kept one and whose first sign-in (the
-- provider's `amr` first-factor time, which a refresh keeps) is at or before
-- the ending (`AUTH_SESSION_EXPIRED`); a sign-in after it is served. The row
-- names no business, person or reason. The application group may insert the
-- digest and the kept session and read the three columns; it changes and
-- removes nothing, and the time is the database's own.

create table ops.ended_subject_sessions (
  subject_digest text not null check (subject_digest ~ '^[0-9a-f]{64}$'),
  kept_session uuid,
  ended_before timestamptz not null default now()
);
create index ended_subject_sessions_subject on ops.ended_subject_sessions (subject_digest);
revoke all on ops.ended_subject_sessions from public;
grant select (subject_digest, kept_session, ended_before), insert (subject_digest, kept_session)
  on ops.ended_subject_sessions to ops_astro_app;
