-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 20261003222410 an invitation accepted on its one-time link (C39-T, piece P3).
--
-- A token moves once, by `spent_at` alone: when its invitation is accepted,
-- and when a resend or a revoke ends every token minted before it, so a link
-- an email already carried does nothing after either (SEC27 F5). Nothing
-- else of a token is ever rewritten.

grant update (spent_at) on public.enrolment_tokens to ops_astro_app;
