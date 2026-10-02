<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The security pass against staging

S0-5 gate item 7: an OWASP ZAP baseline scan and an authenticated ZAP API scan
against staging, on made-up data, from a job anyone with repository access can
start. The agent's attack-style review, the third leg, is recorded apart.

## The job

`.github/workflows/security-scan.yml`, started by hand from the Actions tab with
staging's address. It never runs on a pull request, a push or the merge queue,
and no required check names it. In order:

1. Refuses any target but the environment's `STAGING_WEB_URL`, and writes the
   API scan's OpenAPI document from the command surface.
2. Makes a scan login: a confirmed sign-in at `scan-<12 hex>@alpha.local`
   mapped to a new person "Scan Alpha", a member of `alpha` with a member's
   grants (task read, write and assign; person read; settings read).
3. Runs the baseline scan signed out, then the API scan of every command route
   with the scan login's token sent to the target's host only, active scanning
   capped at 45 minutes. The API scan sends attack values to real commands, so
   staging holds what it made until the next reset.
4. Writes the findings table to the run's summary, then removes the scan login
   whatever happened: it checks the sign-in and the person are the scan
   login's own, ends the grants, membership and acting identity, and deletes
   the sign-in.
5. Keeps the table, its JSON and the baseline's reports for 90 days; the API
   scan's raw reports, made with the token, stay on the runner.

## Severity

ZAP's high is a blocker, medium a major and low a minor; blockers and majors
fail the run, minors pass and are listed. Informational alerts are listed apart
and never fail. A blank or other risk code, or a missing or unreadable report,
fails the run. Every blocker and major is fixed; each minor is the owner's to
fix or accept in one line (impact, compensating control, an expiry after the
acceptance day).

## Settings

Secrets of the GitHub environment `staging-scan`, read by name. None exists in
GitHub yet (the repository has no Actions secrets; its one environment is
`copilot`); the values are staging's own, as the Vercel function and the
staging reset hold them. Required reviewers on the environment make each run
wait for a person.

`STAGING_WEB_URL` (the only target allowed), `STAGING_PROJECT_REF`,
`PRODUCTION_PROJECT_REF` (refused everywhere), `DATABASE_URL` (the runtime
login), `DATABASE_LOOKUP_URL` (the lookup login), `GOTRUE_URL`,
`SUPABASE_SERVICE_KEY` (makes and deletes the scan login) and
`SUPABASE_PUBLISHABLE_KEY` (its password sign-in). It never reads
`DATABASE_ADMIN_URL`, and prints no address, key, password or token.

## The local dry run

Run the workflow's steps by hand against a local stack with
`SCAN_LOGIN_PLACE=local` (this machine's addresses only), `DATABASE_LOOKUP_URL`
set to the stack's admin address, `SUPABASE_SERVICE_KEY` from
`localServiceToken` (`scripts/local/signing-key.mjs`) and the target
`http://host.docker.internal:<port>`. ZAP matches `ZAP_AUTH_HEADER_SITE` by host
name alone, without the port.
