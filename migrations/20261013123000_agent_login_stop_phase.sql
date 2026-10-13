-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The agent login tool's stop receipt (`scripts/ops/agent-login-stop.ts`) is an
-- act row in phase `stopped`: it carries the stopped login's subject, the stamps
-- a restore checks, and its ban, owed until the provider bans the subject (or
-- shared, when the subject is live in another business and nothing global is
-- done). It is open while its ban is owed and closed once it is not.

alter table ops.agent_login_acts drop constraint agent_login_acts_phase_check;
alter table ops.agent_login_acts add constraint agent_login_acts_phase_check
  check (phase in ('reserved', 'user_made', 'bound', 'probed', 'stopped'));
