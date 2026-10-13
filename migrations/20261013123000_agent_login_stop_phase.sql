-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The agent login tool's stop receipt (`scripts/ops/agent-login-stop.ts`) is an
-- act row in phase `stopped`, one for each login a stop turned off: it carries
-- that login's subject, the stamps a restore checks, and its ban, owed until the
-- provider bans the subject (or shared, when the subject is live in another
-- business and nothing global is done). A receipt is a closed row from the
-- start, so a stop of several logins keeps one open act per agent; a ban still
-- owed is read from `ban`.

alter table ops.agent_login_acts drop constraint agent_login_acts_phase_check;
alter table ops.agent_login_acts add constraint agent_login_acts_phase_check
  check (phase in ('reserved', 'user_made', 'bound', 'probed', 'stopped'));
