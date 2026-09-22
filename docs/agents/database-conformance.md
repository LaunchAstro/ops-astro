# Database conformance, and why one of its jobs is red

Item 6 of the PG0 product ticket asks for a hosted job that runs a part's
named invariant suite and the affected conformance suites against a real
database, and fails when any database test skips.

Two things are kept apart here, deliberately, because collapsing them is the
failure the ticket names.

## Proving the gate

`database conformance gate` runs `pnpm run db:cases`. Those probes start a
throwaway Postgres of their own, run controlled fixture suites through
`scripts/db-conformance.mjs`, and assert what the runner refuses:

- a fixture suite that reaches the database passes;
- a fixture suite with one `test.skip` fails, and the skipped test is named;
- a manifest naming a suite that is not on disk fails;
- a run in which zero tests executed fails;
- a suite that passes without the database recording a transaction fails;
- an empty manifest fails;
- a missing `DATABASE_URL` is refused rather than skipped.

This job is green, and what it proves is that the enforcement works. It
proves nothing about the product, and it must not be read as if it did.

## Claiming product conformance

`database conformance` runs `pnpm run db:conformance` against a Postgres
service container, reading `tests/db/named-suites.json`.

**On this head it fails, and that is the correct result.** There is no product
invariant suite and no conformance suite in this repository yet, so the
manifest names none, and an empty manifest is a failure. The alternative is a
green tick beside the words "database conformance" that would mean only that
nothing ran. A check that passes when it did nothing is worse than no check,
because it is quoted later as evidence.

## The sequencing, stated plainly

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
(`publication-v2/03-pg0-product.md:36`): before the first port is dispatched,
not during or after the first port's pull request.

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

### The red on this head

`database conformance` fails here, and that failure does not block PG0:
neither context is bound on ruleset `23396133` today, so the result is visible
without being merge-blocking. What the red shows is the runner refusing to
pass vacuously over an empty manifest. It is not a broken job, and it is not a
reason to soften either the missing-suite refusal or the empty-manifest
refusal. Those two refusals are what make step 3 worth anything.

No other sequencing conflict remains between this job and the ticket.

## What the runner enforces

`scripts/db-conformance.mjs` exits 0 only when all of these hold:

1. `DATABASE_URL` is set and the database answers;
2. the manifest names at least one suite;
3. every named suite exists on disk;
4. more than zero tests executed;
5. no test was skipped or marked todo;
6. no test failed;
7. the database's own transaction counter moved while the suites ran.

Rule 7 is the one worth explaining. A suite can pass with every database
assertion deleted, and rules 4 to 6 will not notice. The runner reads
`pg_stat_database` before and after, and measures what its own reads cost
first, so the threshold is calibrated on that database rather than guessed.

## Credentials

There are none. The service container is given a throwaway password in the
workflow file, it is thrown away with the container, and it reaches nothing
else. No repository secret is used by either job, and none should be: a check
that needs a real credential to prove a database was reached is proving
something other than what it claims.
