-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0065 ended provider sessions (C58 refresh revoked, the API's half). A
-- signed-out token is refused from its next call, not at its expiry, in every
-- business its login reaches.
--
-- A session is the sign-in provider's `session_id` claim, which a refresh
-- carries unchanged. 0057's `ended_sessions` records an ending in the business
-- where it was asked; the browser's sign-out (`/api/session/end`) names no
-- business, and one login may be a member of several. So an ended session is
-- also written here, installation-wide, and login resolution refuses a token
-- whose session is here (`AUTH_SESSION_EXPIRED`), whatever business it asks.
--
-- The row is the session's id and nothing else: no person, login, business or
-- reason, so it says nothing about anyone to a caller who could read it. The
-- application group may insert and read that one column; it changes and
-- removes nothing, and the time is the database's own. An ended session stays
-- ended.

create table ops.ended_provider_sessions (
  session_id uuid primary key,
  ended_at timestamptz not null default now()
);
revoke all on ops.ended_provider_sessions from public;
grant select (session_id), insert (session_id) on ops.ended_provider_sessions to ops_astro_app;
