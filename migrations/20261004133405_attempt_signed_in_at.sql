-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 20261004133405 a resolved attempt records its session's first sign-in (#771).
-- A session's absolute limit is 12 hours from the provider's first sign-in,
-- which a refresh carries unchanged; the door refuses a token past it. The
-- live-session list (0057) filtered on attempt time, so an old session's recent
-- calls kept it listed as signed in now for up to another 12 hours after the
-- door had stopped serving it.
--
-- The column is that first sign-in time, written beside `session_id` and only
-- when a session is named, so the list can drop a session past its limit.
-- Nullable: refused attempts, tokens naming no session, and every row written
-- before this migration carry none, and the list falls back to the session's
-- earliest attempt for those. No row is rewritten; no policy or grant changes
-- (the role keeps insert and select only).

alter table public.authentication_attempts add column signed_in_at timestamptz;
