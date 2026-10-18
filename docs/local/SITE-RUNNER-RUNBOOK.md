# Site runner runbook

How the site runner ([SITE-RUNNER.md](SITE-RUNNER.md)) is installed on the M5, parked and stopped.
Every step here is the owner's, or an agent's with the owner's yes. Starting
it in production is the owner's daylight go. No value below is ever pasted
into chat, a ticket or a file other than the one named. Bitwarden holds each
secret by name.

## Install

1. **The agent.** Make the runner's agent actor and its login with
   `scripts/ops/agent-login.mjs make` through the custody wrapper, as for the
   M5 worker. The password goes in Bitwarden as "Ops Astro site runner agent
   login". Give the agent read and write on the agency's own tasks, so its
   pickup can draw the lease's delegation.
2. **The database login.** As the database owner, over TLS:

   ```sql
   create role site_runner login password '<from Bitwarden>' connection limit 2
     in role ops_astro_app;
   ```

   It owns nothing and creates nothing. Its reach is `ops_astro_app`'s, under
   row-level security per business. Its address goes in the settings file
   only, with `?sslmode=require`. The password goes in Bitwarden as
   "Ops Astro site runner database login".

3. **Custody's credential file.** The two site entries, `source_control` and
   `hosting`, written once by the wrapper of #1691, mode 600. The runner reads
   neither value: custody does.
4. **The settings file.** Mode 600, one JSON object of strings:
   `OPS_ASTRO_API_URL`, `OPS_ASTRO_BUSINESS` (the business key),
   `OPS_ASTRO_BUSINESS_ID`, `OPS_ASTRO_EMAIL`, `OPS_ASTRO_PASSWORD`,
   `OPS_ASTRO_GOTRUE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
   `SITE_RUNNER_DATABASE_URL`, `SITE_RUNNER_CREDENTIALS_FILE` (step 3),
   `SITE_RUNNER_PAGES` (the agency's bound pages, exact, comma-separated:
   `https://agencyastro.com/about`) and `SITE_RUNNER_HEARTBEAT_URL` (its own
   heartbeat check). The runner refuses to start when anyone else can read the
   file, when the database address does not require TLS, or when a page is
   not an exact https address.
5. **The build.** A deployed main build at a released commit, never a lane
   checkout. Fill the `@…@` values in `deploy/m5/ops-astro-site-runner.plist`
   and copy it to `~/Library/LaunchAgents/`.
6. **Start (the owner's daylight go).**
   `launchctl bootstrap gui/501 ~/Library/LaunchAgents/ops-astro-site-runner.plist`.
   launchd starts it again if it stops (`KeepAlive`, 30 s throttle).

## Park, stop and check

- **Park:** `launchctl bootout gui/501/ops-astro-site-runner`. The plist
  stays. A lease it held lapses, and the next start picks the work up again
  and observes it, never sending twice.
- **Stop:** park, then remove `~/Library/LaunchAgents/ops-astro-site-runner.plist`.
  To withdraw its database reach too: `drop role site_runner;`.
- **Check:** each pass logs one line per correction, its id and outcome, and
  pings the heartbeat. A stopped or failing runner pings nothing, so the
  watcher mails. A raised person task logs `raised <code> on task <id>` and
  is written as an internal comment on the correction's task.
