<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The security pass against staging

S0-5 gate item 7, the scans: `.github/workflows/security-scan.yml`, started by
hand from the Actions tab with staging's address. It never runs on a pull
request, a push or the merge queue, and no required check names it. The
agent's attack-style review, the third leg, is recorded apart.

It refuses any target but the environment's `STAGING_WEB_URL` and runs the ZAP
baseline scan signed out. Then it makes a scan login (`scan-<12 hex>@alpha.local`,
person "Scan Alpha", a member of `alpha` with a member's grants), runs the ZAP
API scan of every command route signed in (the token sent to staging's host
only, 45 minutes at most), and removes the login whatever happened, unless another
business maps the same sign-in to a person of its own: then nothing is removed.
The login's record names the sign-in before the provider is asked to make it,
so a second make is refused and a make cut short, or whose reply was lost, is
still removed. A removal waits for a make still under way, then holds the access
lock and the login subject lock until the provider has deleted the sign-in: a
mapping any business writes meanwhile is refused. The API scan
sends attack values to real commands; staging keeps what it made until the
next reset. The findings table goes to the run's summary and, with the
baseline's reports, into the artefact for 90 days; the API scan's raw reports,
made with the token, stay on the runner.

## Severity

ZAP's high is a blocker, medium a major and low a minor. Blockers and majors
fail the run; minors pass and are listed for the owner to fix or accept in one
line (impact, compensating control, an expiry after the acceptance day).
Informational alerts are listed apart and never fail. A blank or other risk
code, a missing or unreadable report, or an API scan answered mostly 401 (not
signed in) fails the run.

## Settings

Secrets of the GitHub environment `staging-scan`, by name; none exists in
GitHub yet. Set required reviewers and deployment branches `main` only on it.
`STAGING_WEB_URL`, `STAGING_PROJECT_REF`, `PRODUCTION_PROJECT_REF`,
`DATABASE_URL` (the runtime login), `DATABASE_LOOKUP_URL` (the lookup login),
`GOTRUE_URL`, `SUPABASE_SERVICE_KEY` (makes and deletes the scan login) and
`SUPABASE_PUBLISHABLE_KEY`. It never reads `DATABASE_ADMIN_URL` and prints no
address, key, password or token.

A local dry run takes the same steps with `SCAN_LOGIN_PLACE=local` (this
machine only), `DATABASE_LOOKUP_URL` set to the stack's admin address,
`SUPABASE_SERVICE_KEY` from `localServiceToken`
(`scripts/local/signing-key.mjs`) and the target
`http://host.docker.internal:<port>`. ZAP matches `ZAP_AUTH_HEADER_SITE` by
host name alone.
