# A6: hosted scheduled entry (design, revision 1)

Ticket #1744, spec #1653 slice A6. Read at main `0ef48dd03`. Design first: this
page is for Sol's design check, and nothing below is built until it passes.

## 1. Read-only record (18 October 2026, 03:45 to 03:55 UTC)

What was read, without changing anything, and what could not be read.
Unknown stays unknown.

| Where                                                       | What was read                                                                                                                                         | What it shows                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source, `apps/api/function.ts` (the Vercel function entry)  | The whole entry at `0ef48dd03`                                                                                                                        | No occurrence sweep. Per request it runs the reconciliation pass (`passDeployment`) over `RECOVERY_BUSINESS_KEYS`, and nothing on a timer.                                                                                                                                                                                                                 |
| Source, `apps/api/server.ts:713` (the long-running process) | A1's switch (#1658)                                                                                                                                   | Starts `startOccurrenceSweeper` only with `AUTOMATION_FIRING=on`. Vercel does not run this entry.                                                                                                                                                                                                                                                          |
| Vercel `ops-astro-production` (ops.agencyastro.com)         | Project settings, the current production deployment `dpl_5WDWdNCZaknyFbQ9uJvqcWeT5aQM` (15 Oct), the names and targets of its 19 environment settings | No cron in the project or the deployment. No setting named `AUTOMATION_FIRING`. No values were read.                                                                                                                                                                                                                                                       |
| Vercel `ops-astro-staging` (app.opsastro.com)               | The same, deployment `dpl_9NVRKKqkDNjDcMm41HcMGb2Lr6qk` (15 Oct), 14 setting names                                                                    | No cron. No `AUTOMATION_FIRING`. No values were read.                                                                                                                                                                                                                                                                                                      |
| The environment machine (M5)                                | `launchctl list`, `~/Library/LaunchAgents`, running containers, processes running `apps/api/server.ts` or `apps/worker`                               | Jobs: the two backups and two backup expiries per environment, the model agent. Containers: forwarders, egress relays, backup stores. No API process, worker or sweep for either environment. One lane's local demo runs `apps/api/server.ts` (not an environment); its settings were not read, since reading a process's environment would print secrets. |
| GitHub Actions                                              | The four scheduled workflows (`lookahead`, `codeql`, `scorecard`, `visual-drift-nightly`)                                                             | None reaches the sweep.                                                                                                                                                                                                                                                                                                                                    |
| **Not read**                                                | A database-side scheduler (`pg_cron` or a provider scheduled function) on either Supabase project                                                     | No read was made against a shared or production database. Unknown.                                                                                                                                                                                                                                                                                         |

As read: neither environment sweeps occurrences today, and a hosted
installation has no scheduled caller. Whether a database-side scheduler exists
is unknown, and nothing in source would call the sweep from one.

## 2. The entry

A one-shot command, `pnpm automations:sweep [--environment <name>]`
(`apps/automations/sweep.ts`), run every minute by a launchd job on the
environment's machine (`deploy/<env>/ops-astro-<env>-occurrence-sweep.plist`,
`StartInterval` 60), beside the backup and endings jobs. One invocation is one
round, then it exits:

1. Reads `AUTOMATION_FIRING`. Anything but `on`: prints
   `automation sweep: firing off`, opens no connection, exits 0.
2. Opens the application login (`DATABASE_URL`, runtime source) and the lookup
   login (`DATABASE_LOOKUP_URL`), and resolves `AUTOMATION_BUSINESS_KEYS` to
   business ids exactly as the function resolves `RECOVERY_BUSINESS_KEYS`. A
   named environment must set it, if only to `none`. The entry refuses to start
   with `DATABASE_ADMIN_URL` set.
3. Runs the existing `occurrenceRound` (`apps/api/occurrence-sweeper.ts`) once,
   unchanged in what it sweeps: each business in its own transaction under its
   own scope, as its own active worker actor (`kind = 'worker'`, `active`). A
   business with none is skipped.
4. Prints one line of counts and no ids:
   `{"firing":"on","swept":n,"noWorker":m,"failed":f}`. Exit 1 if any business
   failed, so launchd's log and the forwarder see it.

To report skips, `occurrenceRound` gains an optional report callback. The API
sweeper passes none and behaves as today.

### Why not a Vercel cron

A Vercel cron calls an HTTP path on the function. That path would be a new
route to claim, dispatch and run start, reachable by any request that carries
its secret, which the ticket's last criterion rules out. Per-minute crons also
depend on the Vercel plan (a provider setting and possibly a cost). The
environment machine already runs this installation's scheduled work (backups,
upkeep, endings) with the logins it needs, and needs no provider change.

### Concurrency

launchd does not start a job while its previous run is still going. The proof
does not rely on that: two invocations at once, and a second invocation for
the same minute, each start every run once, through the existing claim
uniqueness (`activation_occurrences_due_once`, dispatch's recheck under the
activation lock, `activation_occurrences_run_once`). The API process sweeper
and this entry together are covered by the same proof.

### Authority and separation

- No HTTP route, CLI verb or catalogue entry is added. The entry is a process
  on the operator's machine, run by launchd, and no person's or agent's request
  can reach it.
- Each business's pass runs under `withBusiness` with that business's own worker
  actor. The business list comes only from the entry's own settings, so an
  installation that names business A never opens B's scope.
- The application login is the one the endings loop already holds on that
  machine. No new role and no new grant.

## 3. Settings and switch-on

- `deploy/<env>/README.md` gains the job, its env file
  (`AUTOMATION_FIRING`, `AUTOMATION_BUSINESS_KEYS`, `DATABASE_URL`,
  `DATABASE_LOOKUP_URL`) and the rule that unset means off.
- The job ships unloaded with the setting absent. A5 loads it with
  `AUTOMATION_FIRING=on` on staging first, then production after the runs
  gates and the owner's go, in daylight.
- A1's API process switch is unchanged. An operator runs the sweep through one
  entry per environment, never both on; both on is safe (the claim uniqueness
  holds) but doubles the work.

## 4. Proofs (each red first)

Under `tests/automations/`, each with its suite file, named by behaviour:

1. `the-scheduled-entry-sweeps-nothing-unless-firing-is-on`: unset, `off`,
   `On` and `on ` each sweep no business, open no connection and print firing off.
2. `the-scheduled-entry-fires-a-due-activation-as-the-business-worker`: with
   `on`, an adopted one-minute activation gets one occurrence and one run,
   started by that business's worker actor. A business with no active worker
   is skipped and counted in `noWorker`.
3. `overlapping-or-repeated-scheduled-entries-start-each-run-once`: two
   invocations at once on separate connections, and two for the same minute,
   give one occurrence and one run per due time.
4. `the-scheduled-entry-never-sweeps-a-business-it-was-not-given`: entry given
   A only; B's due activation gets no occurrence and no run.
5. `the-scheduled-entry-is-not-a-route`: the route census and the catalogue
   are unchanged, and the run-start scan (`tests/automations/run-start-scan.ts`)
   names the entry as a production caller of `sweepOccurrences` alongside the
   API process.

## 5. Size

About 90 product lines (entry 60, report callback 10, plist 20), plus the two
runbook sections. Under the spec's 150 to 250.

## 6. For the design check

- Whether running the sweep on the environment machine rather than on the
  hosting provider meets "hosted-compatible": it serves a hosted installation
  (Vercel and Supabase) with no provider change.
- Whether the report callback on `occurrenceRound` counts as a sweep change.
  It changes nothing about what is swept.
- The database-side scheduler stays unknown. Recommend: A5's staging check
  reads it with the operator's own login before switching on.
