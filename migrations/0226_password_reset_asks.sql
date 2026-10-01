-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0226 password reset asks, by source (C40). Each well-formed
-- `POST /api/password/reset` ask is one row, written before the login
-- provider is asked to start a reset (`auth.recover`): the client address it
-- came from, as a SHA-256 digest, and when. The ask's per-source limit counts
-- these rows in the last hour, refused asks included, so one source cannot
-- keep the provider minting tokens and spending its mail and address budget.
-- The row names no address, login, business, person or token. The
-- application group may insert the digest and read both columns; it changes
-- and removes nothing, and the time is the database's own.

create table ops.password_reset_asks (
  source_digest text not null check (source_digest ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default now()
);
create index password_reset_asks_source
  on ops.password_reset_asks (source_digest, recorded_at);
revoke all on ops.password_reset_asks from public;
grant select (source_digest, recorded_at), insert (source_digest)
  on ops.password_reset_asks to ops_astro_app;
