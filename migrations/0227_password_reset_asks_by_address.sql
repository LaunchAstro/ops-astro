-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0227 password reset asks, by address, and their retention (C40). Each ask
-- row (0226) now also carries the address asked for, as a SHA-256 digest, and
-- the ask's per-address limit counts these rows in the last hour, refused asks
-- included, before the login provider is asked to mint a token: concurrent
-- asks for one address cannot all reach it. The digests are keys for counting,
-- not secrets: an unsalted digest of an IPv4 or a known address is found by
-- trying candidates.
--
-- Asks older than the hour count for nothing, so each ask's own transaction
-- deletes a bounded few of them. The application group may delete a row only
-- through the row policy below, which admits rows older than the hour alone;
-- it reads and inserts every row as before. The hour is the command's
-- RESET_WINDOW_SECONDS.

alter table ops.password_reset_asks
  add column address_digest text check (address_digest ~ '^[0-9a-f]{64}$');
create index password_reset_asks_address
  on ops.password_reset_asks (address_digest, recorded_at);
create index password_reset_asks_recorded on ops.password_reset_asks (recorded_at);

alter table ops.password_reset_asks enable row level security;
create policy password_reset_asks_read on ops.password_reset_asks
  for select to ops_astro_app using (true);
create policy password_reset_asks_write on ops.password_reset_asks
  for insert to ops_astro_app with check (true);
create policy password_reset_asks_expire on ops.password_reset_asks
  for delete to ops_astro_app using (recorded_at < now() - interval '1 hour');

revoke all on ops.password_reset_asks from public;
grant select (address_digest), insert (address_digest), delete
  on ops.password_reset_asks to ops_astro_app;
