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
4. **The settings file.** Mode 600, one JSON object:
   `OPS_ASTRO_API_URL`, `OPS_ASTRO_BUSINESS` (the business key),
   `OPS_ASTRO_BUSINESS_ID`, `OPS_ASTRO_EMAIL`, `OPS_ASTRO_PASSWORD`,
   `OPS_ASTRO_GOTRUE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
   `SITE_RUNNER_DATABASE_URL`, `SITE_RUNNER_CREDENTIALS_FILE` (step 3),
   `SITE_RUNNER_SITE` (below), `SITE_RUNNER_HEARTBEAT_URL` (its own
   heartbeat check, "Ops Astro production site runner", from the Bitwarden
   item "GlitchTip - Ops Astro Production Heartbeats" as
   `PRODUCTION_SITE_RUNNER_HEARTBEAT_URL`) and `OPS_HEARTBEAT_EVERY_MS` (the
   least time between two pings, a little under the check's period: `55000`
   for a 1-minute check, as a pass runs every 15 s; whole milliseconds, at
   most a day, or the runner refuses to start). Each is a string except `SITE_RUNNER_SITE`, which may be
   written as an object. `SITE_RUNNER_LOCATE_ONLY` set to `"1"` runs the
   locate alone (below).

   `SITE_RUNNER_SITE` is the one site the runner acts for, with exactly these
   keys. In production:

   ```json
   {
     "business": "<OPS_ASTRO_BUSINESS_ID, the same value>",
     "holder": "<OPS_ASTRO_BUSINESS_ID: the agency's own site>",
     "repository": "LaunchAstro/agency-astro-astro",
     "defaultBranch": "main",
     "project": "prj_ZP8jeokQCN6SJsyuzkz4ISihdlHm",
     "pages": [{ "pageUrl": "https://agencyastro.com/about", "path": "src/pages/about.astro" }]
   }
   ```

   `business` must be `OPS_ASTRO_BUSINESS_ID`. `holder` is the business, or
   a client of it, which the runner confirms with one read at start-up. Each
   `pageUrl` is an exact https address and each `path` a page file under
   `src/pages/`. The capture checks only these pages. The runner refuses to
   start when anyone else can read the file, when the database address does
   not require TLS, when the heartbeat address is not an https address off
   the machine, or when a setting is missing, unknown or malformed. Its
   one line names the setting and never its value.

   **Locate only.** With `SITE_RUNNER_LOCATE_ONLY` set to `"1"` the runner
   checks waiting corrections and pins new ones, and takes no claim. Custody
   then holds the read routes only, so no write can leave whatever is asked.
   Use it for the first daylight start, before any publish.

5. **The build.** A deployed main build at a released commit, never a lane
   checkout. The review captures need Playwright's pinned headless shell in
   that build: `pnpm exec playwright install --only-shell chromium`. Without
   it each capture fails `CAPTURE_FAILED` and the corrections run as before. Fill the `@…@` values in `deploy/m5/ops-astro-site-runner.plist`
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
- **Check:** each pass logs one line per correction it settled, put off or
  ran, its id and a code, and pings the heartbeat, no more often than
  `OPS_HEARTBEAT_EVERY_MS`. A correction found bound to
  any other site logs `<id> SITE_NOT_CONFIGURED`. A stopped or failing runner pings nothing, so the
  watcher mails. A refused queue logs `the queue was refused: <code>` and a
  queue with no usable answer logs `a pass failed: QueueFault`; neither pings,
  so a runner that can no longer read its queue reads as failing, never as
  idle. A raised person task logs `raised <code> on task <id>` and
  is written as an internal comment on the correction's task.
