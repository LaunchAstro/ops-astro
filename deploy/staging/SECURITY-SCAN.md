<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The security pass against staging

Gate item 7 of ticket S0-5 (`docs/build-safeguards.md`, the gate before the
first real client data): an OWASP ZAP baseline scan and an authenticated ZAP
API scan against staging, on made-up data, from a job anyone with repository
access can start. The third leg, an agent's attack-style review of sign-in,
client isolation and the API, is recorded separately; this job does not run
it.

## What the job does

`.github/workflows/security-scan.yml`, started by hand from the Actions tab
(Run workflow, with staging's address). It never runs on a pull request, a
push or the merge queue, and no required check names it.

1. Refuses any target that is not the environment's own `STAGING_WEB_URL`,
   and writes the API scan's OpenAPI document from the command surface
   (`scripts/security/api-definition.mjs`), so every command route is scanned
   and none is listed by hand.
2. Makes a made-up scan login (`scripts/security/scan-login.mjs make`): a
   confirmed sign-in at `scan-<12 hex>@alpha.local`, made through the sign-in
   provider's admin API, mapped to a new person "Scan Alpha" who is a member of
   `alpha` with a member's grants (task read, write and assign; person read;
   settings read) and nothing more. It signs in and keeps the access token in
   an owner-only file on the runner, masked in the log.
3. Runs the ZAP baseline scan of the target, signed out.
4. Runs the ZAP API scan of every command route, with the scan login's token
   sent to the target's host only, capped at 45 minutes of active scanning.
   The scan sends made-up and attack values to real commands, so staging will
   hold the tasks it made until the next staging reset.
5. Builds the findings table (`scripts/security/findings.mjs`) and writes it
   to the run's summary.
6. Removes the scan login, whatever happened above: it checks the sign-in and
   the person are the scan login's own, ends the person's grants, membership
   and acting identity, and deletes the sign-in.
7. Keeps the table, its JSON and the baseline's own reports as the run's
   artefact `security-scan-findings` for 90 days. The API scan's raw reports
   stay on the runner, because they were made with the token.

ZAP is `ghcr.io/zaproxy/zaproxy` 2.17.0, pinned by digest and recorded in
`docs/supply-chain-pins.md`.

## How findings are judged

The closing rule's mapping (S0-5, closing rule; ORCH65's ruling of 2 October
2026 for informational alerts):

| ZAP risk                     | Severity  | The run        |
| ---------------------------- | --------- | -------------- |
| High                         | blocker   | fails          |
| Medium                       | major     | fails          |
| Low                          | minor     | passes, listed |
| Informational                | info list | passes, listed |
| Blank or any other risk code | blocker   | fails          |

A report that is missing, unreadable or names no site fails the run, so a scan
that reached nothing never passes. Every blocker and major is fixed. Each minor
is the owner's: fixed, or accepted in one line naming its impact, a
compensating control and an expiry date after the day it is accepted (the
sittings checklist, S5). Informational alerts need no owner line.

## The settings it reads

All from the GitHub environment `staging-scan`, as secrets, by name. None of
them exists in GitHub today: the repository holds no Actions secrets and its
only environment is `copilot`. Each value is staging's, already kept for the
Vercel function and the staging reset; the owner adds them to the environment
before the first run.

| Name                       | What                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| `STAGING_WEB_URL`          | staging's address; the only target the job will scan                |
| `STAGING_PROJECT_REF`      | staging's Supabase project reference                                |
| `PRODUCTION_PROJECT_REF`   | production's, when it has one; every address is refused inside it   |
| `DATABASE_URL`             | the runtime login (`ops_astro_api`), through the pooler             |
| `DATABASE_LOOKUP_URL`      | the lookup login, to read the business's id as the API does         |
| `GOTRUE_URL`               | staging's sign-in address (`https://<ref>.supabase.co/auth/v1`)     |
| `SUPABASE_SERVICE_KEY`     | the sign-in provider's admin key, to make and delete the scan login |
| `SUPABASE_PUBLISHABLE_KEY` | the publishable key, for the scan login's password sign-in          |

The job never reads `DATABASE_ADMIN_URL`. Every address is checked against
staging's project before anything connects (`scripts/security/scan-login.ts`),
and nothing it prints carries an address, a key, a password or the token.
Setting required reviewers on the `staging-scan` environment makes each run
wait for a person's yes.

## The local dry run

The same steps against a stack on this machine, with `SCAN_LOGIN_PLACE=local`
(which takes only addresses on this machine). With a local stack's API on
`127.0.0.1:<api>` and its GoTrue on `127.0.0.1:<auth>`:

```sh
WORK=$(mktemp -d) && chmod 777 "$WORK"
export SCAN_LOGIN_PLACE=local SCAN_LOGIN_FILE="$WORK/scan-login.json" SCAN_TOKEN_FILE="$WORK/scan-token"
export DATABASE_URL=<.local/db.env DATABASE_URL> DATABASE_LOOKUP_URL=<.local/db.env DATABASE_ADMIN_URL>
export GOTRUE_URL=http://127.0.0.1:<auth>
export SUPABASE_SERVICE_KEY="$(node -e "import('./scripts/local/signing-key.mjs').then(async (m) => console.log(await m.localServiceToken(process.cwd())))")"
node scripts/security/api-definition.mjs --target http://host.docker.internal:<api> --business alpha --out "$WORK/api-definition.json"
node scripts/security/scan-login.mjs make
docker run --rm -v "$WORK:/zap/wrk:rw" <ZAP image> zap-baseline.py -t http://host.docker.internal:<api> -J baseline.json -I
ZAP_AUTH_HEADER_VALUE="Bearer $(cat "$SCAN_TOKEN_FILE")" docker run --rm -v "$WORK:/zap/wrk:rw" \
  -e ZAP_AUTH_HEADER_VALUE -e ZAP_AUTH_HEADER=Authorization -e ZAP_AUTH_HEADER_SITE=host.docker.internal:<api> \
  <ZAP image> zap-api-scan.py -t /zap/wrk/api-definition.json -f openapi -J api.json -I
SCAN_BEARER="$(cat "$SCAN_TOKEN_FILE")" node scripts/security/findings.mjs --report baseline="$WORK/baseline.json" \
  --report api="$WORK/api.json" --out "$WORK/findings" --redact-env SCAN_BEARER
node scripts/security/scan-login.mjs remove
```

Locally the lookup login is the cluster's own admin, which may take the lookup
role; on staging it is the lookup login itself.
