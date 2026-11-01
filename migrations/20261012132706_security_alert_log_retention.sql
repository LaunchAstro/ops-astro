-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The security alert log (0069) keeps ninety days (owner, 12 Oct 2026). The
-- forwarder deletes older rows in its pass (`apps/forwarder/forward.ts`), so
-- it may now read the time and delete; it still reads no kind, and the
-- application still only reads. No function is added.
grant select (at), delete on ops.security_alert_log to ops_astro_forwarder;
