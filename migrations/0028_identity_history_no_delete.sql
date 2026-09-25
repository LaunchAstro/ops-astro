-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0028 the application role may not delete identity history.
--
-- 0002 says a login mapping is appended and deactivated, never deleted, and a
-- merge is reversed without erasing either person's history, yet it grants
-- the application group `delete` on both `person_logins` and `person_merges`
-- (final review round 1, R1-AUTHORITY-55). No code deletes either. `actor_logins`
-- (0008) was granted without delete from the start; these two now match it.
-- Nathan approved it on 24 September 2026.
--
-- A fresh database and an upgraded one hold the same grants. No row is read or
-- rewritten, and every other grant is unchanged: select, insert and update on
-- both tables stay.

revoke delete on public.person_logins, public.person_merges from ops_astro_app;
