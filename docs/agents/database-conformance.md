# Database conformance, and what each of its two jobs proves

Item 6 of the PG0 product ticket asks for a hosted job that runs a part's
named invariant suite and the affected conformance suites against a real
database, and fails when any database test skips.

This file keeps two things apart, because collapsing them is the failure the
ticket names.

## Proving the gate

`database conformance gate` runs `pnpm run db:cases`. Those probes start a
throwaway Postgres of their own, or use the database named by
`DB_CONFORMANCE_CASES_URL` when it is set, run controlled fixture suites
through `scripts/db-conformance.mjs`, and assert what the runner refuses:

- a fixture suite that reaches the database passes;
- a fixture suite with one `test.skip` fails, and the skipped test is named;
- a manifest naming a suite that is not on disk fails;
- a run in which zero tests executed fails;
- a suite that passes without the database recording a transaction fails;
- a named suite vitest never discovered fails, and the path is named;
- a run vitest itself reported as failed fails, with every counted test passing;
- a suite that reaches the database does not cover a sibling that does not;
- a named suite runs alone: vitest reads a path as a substring, so
  `invariant.test.ts` would also run `invariant.test.ts.db.test.ts`; every
  other file the path selects is excluded, and a report holding any other
  file fails;
- an empty manifest fails;
- a missing `DATABASE_URL` is refused rather than skipped.

These probes need Docker, or a database named by `DB_CONFORMANCE_CASES_URL`.
Each throwaway container is ready when `pg_isready -h 127.0.0.1` succeeds
inside it. On a fresh volume the image's init server listens on the Unix socket
only, so a socket check can pass before TCP is up. `tests/ci/db-ready-race.mjs`
reproduces that race (26 of 30 at a 100 ms poll with the socket check, 0 of 30
with TCP).
When neither was there they used to skip, and `pnpm run db:cases` exited 0
with eight probes unrun. That happened in CI too, where it made
`database conformance gate` green over a job that had proved nothing. This
file exists to refuse a skip, and skipping the whole file is the largest skip
available. So the probes now read `CI`: with it set and no database reachable
they fail, naming the reason, and the job goes red.
Locally, with `CI` unset, the skip and its message stay, because a developer
without Docker is not a broken hosted job.

A green on this job proves the enforcement works. It proves nothing about the
product.

## Claiming product conformance

`database conformance` runs `pnpm run db:conformance` against a Postgres
service container, reading `tests/db/named-suites.json`.

**The manifest is the authority.** It holds two lists of paths from the
repository root, and the runner runs every suite in both:

- `invariant`: a part's own named invariant suite, the one that proves the
  thing that part exists to hold.
- `conformance`: the conformance suites a change to that part affects.

A part that lands adds its suites to the manifest, and that is the whole
registration. No count of them is written down here, in the runner or in any
other document, because a number written down is a number the next part makes
wrong: read the manifest for the current set. Its `comment` array records which
part contributed which entries, and which suites are deliberately absent and why.

**A pure unit suite must not be named.** The runner requires each named suite
to move the database's transaction counter during its own run (rule 7 below),
so naming a suite that touches no database fails the job, correctly. The
manifest's comment names the suites this applies to.

**A suite that needs more than a database is not named either.**
`tests/api/server-onerror.test.ts` and `tests/cli/mounted-cli.test.ts` each
spawn the real `apps/api/server.ts` on the loopback port `SURFACE_API_PORT`
names, and without it every case that spawns it is skipped
(`server-onerror.test.ts`'s 'U1: the real server answers a tampered decision
with the named fault', `mounted-cli.test.ts:31`, `:77`). The runner passes its
environment through and does not set that port
(`scripts/db-conformance.mjs:178`), so naming them would fail the job on a skip.
`tests/acceptance/restart-and-expiry.test.ts` stays out for the same reason: its
container-restart case skips unless `L5_RESTART_CONTAINER_NAME` names the
container (`restart-and-expiry.test.ts:135-139`), which `pnpm verify:restart`
does. Each runs as its own step with its variable set.
`tests/acceptance/restart-http.test.ts` is unnamed for the same reason: it skips
unless `L5_RESTART_CONTAINER_NAME` and `L5_RESTART_API_PORT` are both set
(`restart-http.test.ts:53-55`). `tests/runtime/pickup-replay-restart.test.ts`
skips unless `PICKUP_REPLAY_API_PORT` names a port and
`PICKUP_REPLAY_PG_CONTAINER` names its own container
(`pickup-replay-restart.test.ts:27-35`).

`tests/db/final-r1-dbtest-manifest.test.ts` fails when a suite that reaches
`packages/core-records/src/tenancy/testing/fresh-database.ts` through its
imports is neither named in the manifest nor listed there as unnamed with its
reason (`NOT_NAMED`), or is listed but missing from the manifest's comment. It
opens no database itself, so it is not named.
`tests/cli/final-r1-cli.test.ts` is listed there as a pure unit suite: it runs
the CLI against HTTP stand-ins, moves the counter by 0, and its terminal case
skips without a terminal (`final-r1-cli.test.ts:186`).
`tests/reads/final-r1-api-sign-read.test.ts` is listed as failing at the
integration head, because its fixture decided with an object note that
`task.decide` now refuses. The fixture now decides with a string note and
writes the object note as a signed row (`storeNote`), so that reason no longer
holds, and the suite stays unnamed until the manifest names it.

`pnpm db:conformance` needs a database. The runner itself refuses without
`DATABASE_URL` (`scripts/db-conformance.mjs:66-71`) and passes it to each
child vitest process. The named suites then build their own throwaway
databases through `databaseUrlFromEnvironment` in
`packages/core-records/src/tenancy/testing/fresh-database.ts`, which takes
`DATABASE_ADMIN_URL` first and falls back to `DATABASE_URL`. Creating a
database and a login role is the owner's work, and the local contract gives
`DATABASE_URL` to the runtime role `app`, which owns nothing and may create
nothing. So **export `DATABASE_ADMIN_URL` as well as `DATABASE_URL` when you
run this locally**. In the hosted job one URL is enough, because the service
container's URL is already the owner's.

A green here means what the last line the runner prints says it means: the
named suites ran against a real database and none of them skipped. It does not
mean the product is correct, and it does not mean anything is accepted. It is
the floor the other refusals stand on, not a verdict.

## The sequencing: hosted publication and landing

**Everything in this section is a publication and landing requirement for the
hosted repository.** It describes what must be true before a port is dispatched
there, and it is not a prerequisite for building locally: local construction is
authorised while the public gates stay held, and
[the local slice](../local/README.md) is the scope of what is being built. Read
this section when landing a change publicly, not when starting the slice on
your own machine. Nothing here records that any of it has happened.

An earlier version of this file said that a job failing closed on a missing
product suite cannot be bound as a required context before the first product
suite exists, because binding it would block every pull request until that
suite lands, including the pull request that lands it. That is false. A
required context is evaluated on each pull request's own head. The pull
request that adds the first named suite runs `database conformance` against a
manifest that names that suite, and passes. There is no deadlock, and there is
no new gate here for anyone to rule on.

The ticket already settles the timing. Its acceptance criterion is that the
hosted job "is bound as a required context before the first port dispatch"
(the PG0 product ticket, item 6, held outside this repository): before the
first port is dispatched, not during or after the first port's pull request.

The two context names are exactly:

- `database conformance gate`
- `database conformance`

The order:

1. PG0 lands first, through its normal owner merge gates: act 1, the review
   evidence, and Nathan's merge.
2. Before the first port is dispatched, Nathan binds `database conformance`
   and `database conformance gate` as required contexts on ruleset
   `23396133`. That is owner-only, and nothing in this file authorises it.
3. The first port head carries its real named invariant and conformance suites
   in `tests/db/named-suites.json`, and must pass `database conformance` on
   its own head.

### What the job's result means now

The manifest is no longer empty. `tests/db/named-suites.json` names the suites
the landed parts contributed, so a failure of `database conformance` is now a
real one: a suite missing from disk, a skipped test, a run that executed
nothing, a named suite the database never heard from, or vitest's own verdict.
Read the failing line; the runner names the path it is talking about.

Whether either context is bound as required on ruleset `23396133` is owner-only
and is not recorded in this repository. Check the ruleset rather than inferring
it from this page. Nothing here authorises binding it.

The empty-manifest refusal stays in the runner even though the manifest is
filled. It is what stops a later change emptying the list and collecting a
green tick beside the words "database conformance" that would mean only that
nothing ran. A check that passes when it did nothing is worse than no check,
because it is quoted later as evidence. That refusal and the missing-suite one
are what make step 3 worth anything.

No sequencing conflict remains between this job and the ticket.

## What the runner enforces

`scripts/db-conformance.mjs` exits 0 only when all of these hold:

1. `DATABASE_URL` is set and the database answers;
2. the manifest names at least one suite;
3. every named suite exists on disk;
4. more than zero tests executed;
5. no test was skipped or marked todo;
6. no test failed;
7. the database's own transaction counter moved while **each named suite**
   ran, measured around that suite's own run;
8. every suite the manifest names appears in vitest's report, matched on the
   resolved file path, with tests of its own that ran and none skipped;
9. vitest itself reported nothing wrong: its process exited zero without a
   signal, and the report's `success`, its errors and each file's `message`
   are clean.

Rule 7 is the one worth explaining. A suite can pass with every database
assertion deleted, and rules 4 to 6 will not notice. The runner reads
`pg_stat_database` before and after, and measures what its own reads cost
first, so the threshold is calibrated on that database rather than guessed.

That counter used to be read once around the whole run, and a whole-run number
belongs to no suite in particular. Two named suites, one reaching the database
and one holding nothing but `expect(1 + 1).toBe(2)`, both passed: the first
moved the counter and the second was carried by it. So the runner spawns
vitest once per named suite and reads the counter either side of each, and a
suite whose own run moved nothing is named on its own line. The rule costs
one vitest process per suite instead of one for the manifest, and that cost is
what makes the number belong to a path rather than to a total.

Nothing vitest runs before a suite may use that database. The vitest global
setup, `tests/support/global-setup.ts`, creates the cluster-wide roles through
`postgres` for this reason. Run through the configured database, it moved the
counter by 15 on a new cluster and by 3 on a warm one, so a suite that never
touched the database looked as if it had.

Rules 8 and 9 close two greens that rules 4 to 6 cannot see, because those
three read aggregates and an aggregate has no idea which file it came from or
how the run ended. Both were observed, not theorised: the runner returned exit
0 on each.

Rule 8 is the named-but-undiscovered suite. A manifest can name a file that
exists on disk and sits outside vitest's discovery. The runner's disk check
passes, vitest never loads the file, the other named suites supply the counts,
and the summary reads "2 named suite(s), 1 test(s): 1 passed". So every manifest
path must now be bound to an entry in `testResults`, and a suite absent from the
report is a failure naming the path. Aggregate counts never satisfy this on
their own.

Rule 9 is vitest's own verdict. An unhandled rejection fails the run and exits
the process non-zero while every test vitest counted still passes, so
`numFailedTests` stays 0 and rule 6 sees nothing: "2 passed, 0 failed", exit 0.
The runner now reads the process status and signal as well as the report's own
error fields, and any of them exits 1 naming what vitest reported, whatever
the counts say.

## Credentials

There are none. The service container is given a throwaway password in the
workflow file, it is thrown away with the container, and it reaches nothing
else. Neither job uses a repository secret, and neither should: a check
that needs a real credential to prove a database was reached is proving
something other than what it claims.
