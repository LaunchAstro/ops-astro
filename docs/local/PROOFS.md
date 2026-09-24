<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The assembled proofs, as lane L5 built them

`tests/acceptance/` checks whether the mechanisms the other lanes built hold,
through the surfaces a caller has. None of it is a plan and none of it counts
declarations. Where a proof could not be written, this file names it.

## Current counts, and what they are

Each count below carries one of three labels:

- **implemented**: the code or test is on the branch, and no run is claimed
  for it;
- **tested (merge trial)**: the named command passed on the integration
  trial of a merge. This is a run, not a review;
- **accepted**: a review recorded it against a head.

**Nothing below is accepted.** The last head with a complete live verification
is `d62f1bc`: checks, a reseed at migration 0023, `verify:slice` 48 of 48,
`verify:browser` 88 of 88 and the restart proof 25 of 25. Its evidence is kept
with the build run under `runs/6f15252`, outside this repository. The landing
history was rewritten with every tree kept, so each commit took a new hash. The
hashes in these docs are the new ones; evidence kept outside the repository is
still filed under a head's old hash, as `runs/6f15252` and `runs/54700f7` are.
Heads merged
since have merge-trial evidence only: each lane was merged with the commands
below run on the integration trial, and nothing more. The joint gates at
`b483399`, the merge of GRANT-EXPIRY-INTAKE (`55c5f19`), PROJECTION-SNAPSHOT
(`640c435`) and RETRY-BOUNDS (`b483399`), passed: `pnpm test` 5,210 passed and
24 skipped, `tests/acceptance` 3,850 and 16, `db:conformance` 107 named suites,
4,713 of 4,713. SOL-RUNTIME-FIX, SOL-AUTHORITY-FIX and DOCS-4 merged next, and
the joint gates at `06ab232` passed. `056aa7c`, the next batch, was red on one
test file and fixed forward at `d31afc1`. The batch merge of TEST-TIMEOUTS,
THERMO-SURFACE, THERMO-AGENT, THERMO-RUNTIME, COMMAND-CATALOGUE and DOCS-5 at
`9ddfa09` passed every joint gate: `pnpm test` 5,376 passed and 24 skipped,
`tests/acceptance` 3,850 and 16, `db:conformance` 114 named suites, 4,741 of
4,741 (events log, 2026-09-24T01:31:58Z). `ca0b79c` added WORDING and
LIVE-PREP, and its joint gates passed with `pnpm test` 5,398 and 24. The
next head, `67fa922`, is `ca0b79c` plus DOCS-6, SWEEP-2, SOL6-RUNTIME-FIX-2,
SOL6-WEB-FIX, SOL6-AUTHORITY-FIX-2, THERMO-2, PROTECTED-MIGRATIONS (the last
migration is 0025), OWNER-RULINGS-FIX and ARCH-4. Its joint gates passed with
`pnpm test` 5,465 and 24, `tests/acceptance` 3,852 and 16, and
`db:conformance` 125 named suites, 4,789 of 4,789. `e84add2` added FINAL-SWEEP
(with the SOL6-AUTHORITY-FIX-2 continuation) and passed with `pnpm test` 5,466
and 24, `tests/acceptance` 3,852 and 16, and `db:conformance` 125 named suites,
4,788 of 4,788 (2026-09-24T04:12Z). `9abf30d` adds DOCS-7, THERMO-FIX-WEB,
CAP-RR (migration 0025 edited in place), SPINE-UPGRADE, THERMO-FIX-READS,
THERMO-FIX-RUNTIME and THERMO-FIX-AGENT, and passed with `pnpm test` 5,491 and
24, `tests/acceptance` 3,852 and 16, and `db:conformance` 129 named suites, 4,800
of 4,800. The integrated head, and the head these docs describe, is `1486b4c`.
It adds PR A's gate tooling (`135dd75`), DOCS-8, THERMO-FIX-AGENT-2,
THERMO-FIX-WEB-2, DB-CASES-FIX, THERMO-FIX-WEB-3 and DB-READY-FIX, and its joint
gates passed with the counts in the table. The run at `9da823a` before
DB-READY-FIX was red on `pnpm check` alone, a readiness race in the `db:cases`
harness that DB-READY-FIX closed.
The final live verification at the final head is owed and has not been run.

| What                                                                                                                                                                           | Count                                                                                                | Label                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `typecheck`, `lint`, `format:check`, `spdx`                                                                                                                                    | green                                                                                                | tested (joint gates, the integrated head)                                     |
| `pnpm test`                                                                                                                                                                    | 5,506 passed, 24 skipped                                                                             | tested (joint gates, the integrated head)                                     |
| `tests/acceptance`                                                                                                                                                             | 3,852 passed, 16 skipped                                                                             | tested (joint gates, the integrated head)                                     |
| `db:conformance`                                                                                                                                                               | 129 named suites (122 invariant, 7 conformance), 4,800 of 4,800                                      | tested (joint gates, the integrated head)                                     |
| `db:cases`                                                                                                                                                                     | 15 of 15                                                                                             | tested (joint gates, the integrated head)                                     |
| `pnpm check`                                                                                                                                                                   | green                                                                                                | tested (joint gates, the integrated head)                                     |
| `d06-generated.test.ts`, `d06-agent.test.ts`                                                                                                                                   | 3,706 of 3,706: 2,901 for `d06-generated`, 805 for `d06-agent`                                       | tested (lane run on `e1b78b3`)                                                |
| `role-case-matrix.test.ts` (item 2)                                                                                                                                            | 384 rows: 338 pass, 46 named exceptions, none missing coverage                                       | tested (lane run on `8819fac`)                                                |
| `retry-bounds`, `historical-handback-intake`, `projection-snapshot`, `proposal-snapshot` ([the last three lanes](#retry-bounds-grant-expiry-intake-and-the-proposal-snapshot)) | 3, 16, 4 and 1 tests; `historical-handback-intake` had 13 at `91cda99` and SOL-AUTHORITY-FIX added 3 | tested (lane runs on `867f391`, `91cda99`, `163969b`; merge trial, `06ab232`) |
| `verify:browser`, including the in-flight, R4 and surface-final rows                                                                                                           | 88 of 88 at `d62f1bc`                                                                                | tested (live run, `d62f1bc`); not run since                                   |
| `verify:d06-mounted` ([D06 and D03 on the mounted browser](#d06-and-d03-on-the-mounted-browser-d06-d03-i02-i11))                                                               | 939 of 966 cells, D03 11 of 11; 27 `delegation.revoke` cells unproved                                | tested (lane run on `b1fd9f3`)                                                |
| The restart proof ([item 5](#item-5-the-restart-proof-w06-as-one-named-run))                                                                                                   | 30 of 30, twice, on the RESTART-LEGS lane's own stack; skipped in the counts above                   | tested (lane run on `6e06d3b`); not run at a merge trial since                |

The 24 skipped in `pnpm test` include three groups. The suites that spawn the
real `server.ts` skip without `SURFACE_API_PORT`
(`tests/api/server-onerror.test.ts`, `tests/cli/mounted-cli.test.ts`).
`tests/runtime/pickup-replay-restart.test.ts` skips without its own declared
container. The restart cases skip without their disposable container.
RESTART-LEGS added five restart cases, which is why the skipped count went from
19 at `9f61aa6` to 24 at `d8746a2` with the same 5,199 passed.
The named-suite list and why the port suites stay unnamed are in
[database-conformance.md](../agents/database-conformance.md).

`d06-generated.test.ts` executes 2,898 cells and three plain tests. The cells
are 35 operations × 27 top-level keys × API, CLI and web (2,835: the 22
`SYSTEM_OWNED_FIELDS` plus the installed system fields, from `TOP_LEVEL_FIELDS`
in `d06-cases.ts`), plus 7 `fields` operations × 3 installed system fields on
each of the three surfaces (63). The first two plain tests read the installed
field metadata and list the operations whose bodies carry record fields. That
settles the old 2,375 against 2,373. At `d6a7c36` the file ran 2,373 cells and
the same two tests, 2,375 in all. Each of the 2,898 cells runs between a
passing positive control and a passing clean retry on the same work, and a
third plain test asserts that from the executed tally. That includes person
`task.pickup`, `task.heartbeat` and `task.handback`, which run on the person's
own work (EX-01, those three branches of `handlers.ts`). That work is a fresh
approved reservation, or a lease the person's own pickup took. Until
PROOF-CLOSURE their 243 cells sent fabricated ids with no control and no retry.
`d06-agent.test.ts` holds the contract and exclusion cells for the agent
route, including the top-level system-field keys, which the agent route now
also refuses `FIELD_NOT_WRITABLE`.

The in-flight half of I10 is `tests/acceptance/i10-inflight.test.ts`. A read
is held at admission (after `effectiveGrants`) in its open transaction while
`grant.revoke` commits over HTTP. The read finishes with its content, and the
next call is `AUTH_NO_MEMBERSHIP` (R4 on a `shareRecord` share) or
`SCOPE_NOT_GRANTED` (a member on a record grant). `pg_stat_activity` and the
audit `seq` order show the overlap.

## How to run them

```sh
export PATH=<toolchain>/node-v24.21.0-darwin-arm64/bin:$PATH
set -a && . ./.local/db.env && set +a      # a real Postgres, migrated
pnpm exec vitest run tests/acceptance --fileParallelism=false
```

**`--fileParallelism=false` is required.**
Every file here builds its own throwaway database, but they share one Postgres
_server_, and `restart-and-expiry.test.ts` restarts that server's container. In
parallel, the restart kills the sibling suites' connections and they fail with
`terminating connection due to administrator command` and `ECONNREFUSED`, a
failure that says nothing about the product. Run one file at a time and they
pass. Vitest's file parallelism is set in `vitest.config.ts`, which this lane
does not own, so the run passes the flag instead of editing that config.

`pnpm test` runs `tests/support/global-setup.ts` once first. On a cluster
without `ops_astro_app` and `ops_astro_worker` it migrates and drops one
throwaway database, so parallel files never race on creating those roles. It
does this through the `postgres` database (or `template1` when the configured
database is `postgres`), never the configured one. `pnpm db:conformance` reads
the configured database's transaction counter around each suite, so the warm-up
is not counted as the suite's own.

Hooks have a 60 s timeout (`hookTimeout` in `vitest.config.ts`), because every
database-bound file migrates and drops its own database in `beforeAll` and
`afterAll`. Tests keep Vitest's 5 s default. A slow case names its own
timeout, with a comment saying why.

`.local/db.env` points at the lane's own disposable Postgres. With
`DATABASE_URL` unset every file in the directory skips itself and says so on
the console instead of passing empty, because a proof that quietly ran nothing
is worse than one that did not run.

Each run writes its measured counts to `.local/l5-inventory.txt` and
`.local/l5-matrix.tsv`, which are gitignored. The evidence belongs beside the
run, not in the tree.

## What is being driven

Every case runs in process against the real application.
`tests/acceptance/world.ts` builds the Hono app from `apps/api/app.ts`'s
`createApi` with the real database, the real `executeRead`, the real
`executeAgentCommand` and the real GoTrue-shaped verifier. That is the same
composition `apps/api/server.ts` binds a port to. The suite drives it through
`app.fetch`. There is no network and no API server, and the suite substitutes
nothing below the boundary.

`tests/api/boundary.test.ts` stubs the database on purpose, because its
questions are the transport's. The questions here are the other half: whether
a foreign read refuses, and whether a protected field stays put. A stub would
make every one of them unfalsifiable.

The suite signs the bearers with its own secret; GoTrue does not mint them.
`createSupabaseVerifier` verifies an HS256 token against a deployment secret.
A token signed with that same secret is the same token to every line of
product code, and the subject it carries is a real row in `logins`. The cast
is `scripts/local-seed.mjs`'s cast by name and by role: `ada` admin, `mia`
member, `noah` member with no grant, `orphan` a verified login with no
membership, and `bea` a member of the other business. The suite writes the
agent actor the way the seed writes one. It does not use the seed's external
party (R4): `enrolExternal` in `world.ts` makes its own, a person of `alpha`
with a login and no membership, and `shareRecord` gives it its share. The
suite does not import the seed, because the seed needs GoTrue and writes into
the running slice's database.

## The proof files

| File                        | Covers                                                                                                                                                                                 | State                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `world.ts`                  | the shared fixture; not a proof                                                                                                                                                        | not a proof          |
| `surface-inventory.test.ts` | item 1, the exported-surface inventory (I02 to I06)                                                                                                                                    | green, 10 cases      |
| `role-case-matrix.test.ts`  | item 2, the six roles and nine cases (SPEC 8, T1h, N1 to N7)                                                                                                                           | see the matrix below |
| `protected-fields.test.ts`  | item 3, the protected set on three surfaces (D02 to D04)                                                                                                                               | green, 72 cases      |
| `predicate-rls.test.ts`     | item 4, supplementary to the I14 proof in `tests/tenancy/production-lookup.test.ts`, the four-state predicate/RLS mutation of a copy of `lockTask`'s statement (`commands/prepare.ts`) | 13 cases             |
| `external-party.test.ts`    | R4 over HTTP: the shared read and nothing else (I01, I09)                                                                                                                              | green, 5 cases       |
| `comment-rulings.test.ts`   | the comment rulings: agent comments internal only on both prefixes; a trashed task `NOT_FOUND` to a comment on both                                                                    | tested, 2 cases      |

## The per-file cap, and why two files are harnesses

`scripts/pr-size.mjs` blocks at a per-file cap of 400 changed lines, and its
own error text says no label lifts that cap. `restart-and-expiry.test.ts`
reached 436 and was split, not trimmed, because SPEC section 6's T1h row
answers this case: "split the file, not the change". It names the two things
not to do: delete the comments that say why each assertion is the assertion,
or add the file to the gate's generated list. The lane did neither.

`world.ts` and `restart-harness.ts` assert nothing about the product. A failure
in either is a broken fixture; a failure in a `.test.ts` file is a finding.
That is also why neither belongs in `tests/db/named-suites.json`.

The lane as a whole is over the 400-line total. It is a test directory, and
the coherence waiver exists for that total. This file records it instead of
working around it, and the coordinator decides it at landing time.

## Item 1: the inventory

The enumeration is generated from `COMMAND_SURFACE` itself. The file holds no
list of operation names, which is SPEC section 8's first property: an endpoint
added without a case fails the build. A hand-kept list would have put the
drift in the place least likely to be read.

The run writes every count below; this file does not keep them. The suites
append the numbers to `.local/l5-inventory.txt` and `.local/l5-matrix.tsv` as
they measure. The figures quoted here are the last observed values, and the
files are what to read. The enumeration is generated for the same reason:
L3-PART-B-2 took the table from 28 declarations to 30 and from 5 reads to 7
between this lane's base and its merge, and both rows arrived with no edit to
the proof.

Last measured on branch `slice/matrix-docs`, from `local/working-slice` at
`57bc21b`, on 23 September 2026:

| Count                                                 | Measured               |
| ----------------------------------------------------- | ---------------------- |
| Declarations                                          | 35: 28 writes, 7 reads |
| Reachable on the person prefix `/api/b/:businessKey`  | 35 of 35               |
| Reachable on the agent prefix `/api/a/b/:businessKey` | 35 of 35               |
| Reachable through `apps/cli/client.ts`                | 35 of 35               |
| Reachable through the web client's `read()` verb      | 7 of 7 declared reads  |
| Declared and not landed                               | none                   |
| Person-prefix untyped faults                          | none                   |

The web client's `read()` reaches 7 of 7 declared reads, and none is reachable
only through `mutate()`. The five new rows are L3-CONTROLS' support controls.

Reachable means routed, not permitted: the request arrives at the operation
that owns the rule. Whether the operation then says yes or no is authority, and
authority is item 2's. Collapsing the two would let a route that refuses
everyone count as proof that the surface is served.

### Closed: four reads the mounted app could not reach as reads

`OperationsClient.read()` took three names against seven declared reads, so
`task.queue` and `preset.plan` went through `mutate()` and the settings reads
through a cast. `READ_NAMES` now holds all seven (SPEC-ADJUDICATE (b)), and
`surface-inventory.test.ts` and `tests/surfaces/read-names.test.ts` require
none unreachable.

## Item 2: the six roles and the nine cases

`role-case-matrix.test.ts` with `role-case-harness.ts`, `role-case-bodies.ts`
and `role-case-ledger.ts`. The enumeration is generated from `COMMAND_SURFACE`
and the whole matrix is written to `.local/l5-matrix.tsv` as
`role · case · operation · observed code · observed status · expected · verdict`.

384 rows: 338 pass, 46 named exceptions, zero failures, as
`.local/l5-matrix.tsv` recorded them in the ACCEPTANCE-ROWS lane's run of
`tests/acceptance` on its own Postgres at `8819fac` (tested, lane run). The
joint gates at `9f61aa6` ran `tests/acceptance` green with the same file. The 46
are 14 executed alternative and 32 not applicable; no row is missing coverage.
At `8b7c6cb` and `d62f1bc` it was 363 rows, 336 pass and 27 exceptions: 4
executed alternative and 23 not applicable. ACCEPTANCE-ROWS added the 19
named (c)/(d) rows, which are all exceptions, and two passing (j) rows. At
`4757d72` it was 331 rows, 296 pass and 35 exceptions: 9 executed alternative
and 26 missing coverage. On `slice/capabilities` it was 330 pass, 6 executed
alternative, 23 not applicable and 4 missing coverage: the admin's
`task.pickup` and the member's `task.pickup`, `task.handback` and
`task.heartbeat`. The test change for those four landed with PERSON-WORK's
merge (`4f93f9a`), which gave a person the route. OWN-LEASE-SCOPE (`8b7c6cb`)
changed the production path the rows run through; the L6 packet did not verify
its effect on them.

| Case                                                                                  | Rows |
| ------------------------------------------------------------------------------------- | ---- |
| (a) own-business permitted, the positive control                                      | 35   |
| (b) foreign business in the path                                                      | 35   |
| (c) foreign record id                                                                 | 16   |
| (d) fabricated id                                                                     | 16   |
| (c)/(d) named not applicable or executed alternative                                  | 19   |
| (e) no grant                                                                          | 140  |
| (e) member positive: each pair a granted member holds                                 | 23   |
| (f) grant revoked since the last read (I10)                                           | 4    |
| (g) external projection (I09), the real R4 and the agent                              | 4    |
| (h) pre-pickup agent restrictions and successes (I12), and the approval they rest on  | 36   |
| (i) after pickup: ceiling, out of purpose, narrowed (I07/I08)                         | 44   |
| (j) agent decision excluded on one live gate: propose, excluded, the person's control | 3    |
| (k) real handback, and a delegation revoked through its route                         | 9    |

The (h) approval row is `h-reservation-approved`: the admin's approval that
gives the agent its reservation. It used to be counted under (j), but it
decides a different gate from the one (j) contests.

The matrix asserts (c) and (d) are indistinguishable: same status, same code,
same body shape. That is the half of N1 a foreign-read test usually leaves out.
The swap reaches 16 operations: those that target an existing record, and
`task.read`. Each of the other 19 has one named row, listed under
[What each exception is](#what-each-exception-is), and a declaration with no
row throws.

**Case (g) is the real external party now.** It used to record
`except('external-party', …, 'no non-member role in the seed')`. It now enrols
R4 with `enrolExternal`, shares the agent's task with `shareRecord`, and
observes three passing rows: the shared read (`sharedTask`, no internal note,
no title), a sibling `task.read` and a `task.board`, both `NOT_FOUND`. With the
share taken out, the read row fails `AUTH_NO_MEMBERSHIP` 403. The fourth row is
the agent's own read through `externalCommentProjection`.
`tests/acceptance/external-party.test.ts` is the full R4 suite.

### What each exception is

An exception is a row that records a reason instead of a verdict. None is an
owner waiver, and the word "exception" accepts nothing. Each row's reason
text starts with one of three labels:

- **Executed alternative**: something in this run asserts a different,
  specified outcome for it. The reason names what, and the table cites the
  spec line.
- **Not applicable**: the role does not fit the case, with the spec line that
  defines the case. The row names where the real rows for that operation are.
- **Missing coverage**: nothing in this run asserts it. The reason, or the
  table, names what would, and who owns it.

Of the 46, 27 are the (a), (e) and (i) rows below and 19 are the
`cd-not-applicable` rows after them. By label, 14 are executed alternative
(4 plus 10) and 32 not applicable (23 plus 9).

Four (a) and (i) rows are executed alternatives:

| Rows                            | What is asserted instead                                                                      | Spec line                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- |
| (a) `grant.revoke`              | the admin's revocation succeeds, case (f)                                                     | contract ledger line 36, revocation controls |
| (a) `delegation.revoke`         | the admin revokes a live delegation, case (k); the agent's next call is `DELEGATION_NOT_LIVE` | contract ledger line 36, revocation controls |
| (i) `task.queue`, `task.pickup` | both succeed without a delegation, case (h)                                                   | contract ledger line 62, I12                 |

The four `session.capabilities` rows now pass with the contract's outcome.
(e) `noah`, a member holding nothing, is refused `SCOPE_NOT_GRANTED` (minimum
contract 8.2 case 3); (e) `mia`, who holds grants, is answered her own pairs as
the control. (h) before a pickup the agent login is refused
`DELEGATION_EXCLUDES_OPERATION` (case 9); (i) under the live delegation its
answer has `purposeScope` set to the picked-up task.

Twenty-three rows are not applicable: (e) for `mia`, one on each pair she
holds. Case 3 is R2 against every endpoint (minimum contract line 493), and R2
is a member without that grant (line 481). `mia` holds `task:read`,
`task:write`, `task:comment` and `task:assign`, so a refusal manufactured for
her would be a wrong answer. The two real rows for each such operation are
elsewhere in the matrix:

- `noah`, a member holding nothing, is refused `SCOPE_NOT_GRANTED` on every
  exported operation, so every operation keeps a true no-grant actor. Each of
  those 35 refusals is audited in `audit-per-operation.test.ts` (one refused
  `audit_events` row in alpha naming actor, command, operation and code,
  digest only, no domain change). For `task.pickup`, `task.heartbeat` and
  `task.handback` he names real work: an approved reservation, and a live
  lease and fence `ada` holds.
- The new case (e) member positive drives `mia` on each pair she holds, with
  case (a)'s minimal body. All twenty-three return 200, `task.pickup`,
  `task.handback` and `task.heartbeat` included.

No row is missing coverage. The four that were (the admin's `task.pickup`,
and `mia`'s `task.pickup`, `task.handback` and `task.heartbeat`) pass on the
person route. The admin's `task.handback` and `task.heartbeat` in case (a),
once executed alternatives, pass as well.

Nineteen rows are the (c)/(d) case, recorded as `cd-not-applicable` under
`ada`, one for each operation the swap does not reach (ledger I03, root ruling
3). `alternativeFor` in `tests/acceptance/cd-alternatives.ts` builds each
reason, and `identifier-negatives.test.ts` titles its cases from the same
`CASE` table, so a row and the case it cites cannot drift apart. Ten rows are
executed alternatives: the cited `identifier-negatives.test.ts` case compares a
foreign and a fabricated operand by status and raw bytes, audited at home.

| Operations                        | Operand                    | `identifier-negatives.test.ts` case                                                |
| --------------------------------- | -------------------------- | ---------------------------------------------------------------------------------- |
| `task.cancel`, `task.restart`     | `lineageId` and `recordId` | refuses foreign and fabricated control identifiers alike                           |
| `task.restore`                    | `batchId`                  | refuses foreign and fabricated control identifiers alike                           |
| `grant.revoke`                    | `grantId`                  | refuses foreign and fabricated control identifiers alike                           |
| `delegation.revoke`               | `delegationId`             | refuses foreign and fabricated control identifiers alike                           |
| `task.decide`                     | `gateId`                   | refuses a foreign and a fabricated gate NOT_FOUND, as contract 8.2 case 1 names it |
| `task.board`                      | `board`                    | refuses a board read on a foreign or fabricated board, never an empty success      |
| `task.heartbeat`, `task.handback` | `leaseId`                  | refuses the agent alike on foreign, fabricated and in-business operands            |
| `task.pickup`                     | `reservationId`            | refuses a pickup alike on a foreign, a fabricated and a claimed reservation        |

Nine rows are not applicable, because the operation names no target:
`task.create`, `task.purge`, `settings.set_four_eyes_threshold`,
`settings.set_client_sign_off`, `task.queue`, `person.list`, `preset.plan`,
`settings.read` and `session.capabilities`. With no foreign target there is
nothing to compare with a fabricated one (SC2, root ruling 3). Each row cites
the case "refuses a target a target-free operation has no use for (SC2
reading)". That case shows a positive request moves and shows nothing of
bravo's. It refuses a `recordId` aimed at bravo `COMMAND_BODY_INVALID`, with
its audit row in alpha and none in bravo.

Case (k) drives the three operations the old rows only described:

- **Wrong-purpose lease.** The same agent picks up a second reservation, on
  the sibling and for another purpose. Under the first credential it hands
  back the sibling's lease at that lease's own fence. The answer is
  `DELEGATION_OUT_OF_PURPOSE` 403, because `namedTaskId` in
  `agent-authority.ts` reads the task from the lease. The sibling lease has no
  `handback_reports` row afterwards. This is the (i) `task.handback` row. The
  old text expected `LEASE_NOT_OWNED`, which is the answer for a stale fence
  on a lease in the same purpose.
- **Handback.** A person naming the sibling's lease is refused
  `LEASE_NOT_OWNED` and settles nothing, because a person hands back only a
  lease their own pickup took (EX-01). The test asserts that code directly;
  it is not a matrix row. The sibling's own credential then hands its lease
  back (200, the reservation named), and its next call is
  `DELEGATION_NOT_LIVE`.
- **Revocation.** A third pickup. `noah` is refused `delegation.revoke`,
  `SCOPE_NOT_GRANTED`. The admin revokes it through `delegation.revoke`
  (200), and the agent's next read is `DELEGATION_NOT_LIVE`.

Contract ledger lines are in the build run's
`t1a-revision/CONTRACT-LEDGER.md`. The minimum contract is
`research/minimum-contract-2026-09-10/CONTRACT.md` in the roadmap repository.
Neither is in this tree.

## Item 3: the protected set on three surfaces

Eleven fields, read by name from `PROTECTED_TASK_FIELDS`, submitted in a
`task.update` through the API's person prefix, through `apps/cli/client.ts`
and through the web client's `submitEdit`. That makes thirty-three refusals,
and each one reads the record back out of `public.records` and asserts the
stored value and the revision did not move. A refusal that still wrote is the
failure this proof exists to catch, and a test that only read the response
body could not catch it.

**The refusal is three codes, not one.** The test derives which from the
field's own `writeMode` rather than expecting a single answer:

| Fields on `task.update`                                                                                                    | Code                   | Status |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------ |
| the eight operation-owned (`assignee`, `delegate`, `parent`, `client`, `client_visible`, `stage`, `state`, `intake_state`) | `TRANSITION_PROTECTED` | 422    |
| `completed_at`, `key`                                                                                                      | `FIELD_NOT_WRITABLE`   | 422    |
| `source`                                                                                                                   | `SOURCE_SPOOFED`       | 403    |

`TRANSITION_PROTECTED` names the owning operations, so `intake_state` names
`task.triage`, for any value, `accepted` included. That is the D03 precedence
ruling (see [the rulings table](#engineering-rulings-and-how-far-each-is-proved)).
`refuseSpoof` in `packages/core-records/src/commands/tasks-write.ts` runs before
the engine classifies. On `task.update` it refuses only `source`
(`SPOOFABLE_ON_UPDATE`). On `task.create` it refuses both `source` and
`intake_state` `SOURCE_SPOOFED` (`SPOOFABLE_ON_CREATE`), and the D03 block of
`protected-fields.test.ts` asserts that too, on every surface, creating
nothing. An update that carries both `source` and `intake_state` is answered
`SOURCE_SPOOFED`, because `source` is checked first. The same codes are
asserted by name in `tests/commands/task-fields.test.ts:103-115`. The test reads
every status through `statusOf`, which reads the status column of the register
itself, so it proves the boundary uses the register rather than a number it
chose.

The positive controls sit beside them, because a server that refused
everything would pass the refusal half: `task.assign` for `assignee`,
`task.set_stage` for `stage`, the `task.start` → `task.complete` →
`task.reopen` lifecycle for `state`, which carries D04's `completed_at` derive
and clear, and an ordinary `title`/`due`/`priority` edit.

`completed_at`, `key` and `source` are system-derived and have no owning
operation, so there is no positive control to put beside them. The test file
says so.

**The proof is falsifiable, and a run showed it.** For the demonstration, the
`assignee` case went through `task.assign`, the operation that writes the
field. The database readback then failed 33 cases with
`+ "assignee": "cfaa5cb8-…"`, and passed 38 again on revert. The
refusal-writes-anyway failure this proof exists to catch is reachable.

## Item 5: the restart proof (W06), as one named run

```sh
pnpm verify:restart --evidence .local/restart-proof/<name>.txt
# defaults, declared in scripts/local/restart-proof.sh:
#   --name ops-astro-restart-proof-pg  --port 54398  --api-port 8798
```

`scripts/local/restart-proof.sh` creates a disposable Postgres from the pinned
digest. Before starting anything it refuses if the name or either port belongs
to the working slice, the datafix database or the Hub's `supabase_*` stack, or
if the name already exists or a port already answers. It then migrates the
database at the checked-out head and runs `restart-and-expiry.test.ts`,
`restart-http.test.ts` and `restart-declared.test.ts` with
`--fileParallelism=false` and both restarts asked. The evidence file carries the head sha, the migration output, `StartedAt`
before and after, every compared identity with its state, the API process ids
before and after, each HTTP answer, and the verbose test output. On success and
on failure the exit trap stops every API process the run wrote to its pid file,
records whether the API port is free, removes the container, and writes the
exit status as the last line. Pass is exit 0, `api port free`, `container
removed`, and `Tests 30 passed (30)`, with no expected failure.
The 30 is the count at `3c3ceab` and again at `6e06d3b` (RESTART-LEGS: 25 at
`610983f` plus the five restart legs below); it was 24 before `610983f`. A lane
with its own stack passes `--name`, `--port` and `--api-port` rather than
taking the defaults, which belong to the coordinator.

After the restart, `restart-http.test.ts` also asks for a third
`request_changes` on the same lineage and gets 409 `CHANGE_ROUNDS_EXHAUSTED`,
audited as a refusal (G08, `restart-http.test.ts:478-550`).

**Restart legs (RESTART-LEGS, L6 rows I08, G06, W04, W06 a).** The restarted
process starts with `RECOVERY_BUSINESS_KEYS=alpha,bravo`, the world's own keys
(`WORLD_BUSINESS_KEYS` in `restart-process.ts`), and its stdout is kept. Five
more named cases run in `restart-http.test.ts`:

- **W06 (a).** The identity baseline is read after the first process stops
  and before `restartContainer`. After the restart every table equals it
  except the one hold startup recovery classified and any attempt on that hold.
- **Startup recovery.** A historical rejection is written openly with no
  process serving, the same fixture pattern as `recovery-entry.test.ts`, which
  does not claim that a crash split an atomic owning transition. The restarted
  process prints `restart recovery: alpha committed, 1 classified, 1 released`
  before it serves. A second process restart prints `0 classified` and the
  hold does not move.
- **W04.** An approved, unleased hold snapshotted before the restart is
  unchanged after it and is picked up over HTTP.
- **I08.** Before the restart, `grant.revoke` removes a person's only write
  grant under a live agent lease. Afterwards heartbeat and handback with the same
  credential answer 403 `DELEGATION_NARROWED`. Since AGENT-BOUNDARY-2 (merged
  at `9f61aa6`) the handback keeps its report as one `retained` row naming
  `DELEGATION_NARROWED`, and nothing else moves. A retry of the same operation
  keeps no second row, and a new operation id is a second retained row. The
  explicit `delegation.revoke` control answers 401 `DELEGATION_NOT_LIVE`, and
  its handback keeps one `retained` report (AGENT-BOUNDARY's late intake,
  merged at `2f766d3`).
- **G06.** `task.read` of the gate that lapsed while nothing ran draws it
  `expired` (`expired: true`) on the database clock, and the stored row is
  still `pending`.

Since `2f766d3` the handback-once case also expects the second, refused
handback's report as a `retained` row beside the settled one. At `610983f`
that case was red (`Tests 1 failed | 24 passed (25)`) because it still
expected one receipt.

**Removal on failure is demonstrated.** `L5_RESTART_INDUCE_FAILURE=throw` fails
the run once the restarted container and the new API process are up;
`L5_RESTART_INDUCE_FAILURE=crash` SIGKILLs the runner there, so no `afterAll`
runs. Both exit 1 with no container left and the API port free; in the crash
run the trap itself stopped the orphaned API process (`api stopped by trap`).

**The container is declared, not hard-wired.** The case reads
`L5_RESTART_CONTAINER_NAME`. Before any restart, `refusalFor` in
`restart-harness.ts` refuses an undeclared name, any name on the deny list
(`ops-astro-local-pg`, `ops-astro-datafix-pg`, `supabase_*`) without asking the
daemon anything, and a container whose published 5432 port is not the port in
`DATABASE_URL`. A refusal fails the case with its reason. It is never a skip.
`restart-declared.test.ts` holds those refusals, and it runs on every
invocation because it needs no database. Without either variable the two
restart cases are skipped and printed as skipped, so a plain
`vitest run tests/acceptance` on a shared server still never restarts it.

**The API is restarted as a real process.** With `L5_RESTART_API_PORT` set,
`restart-process.ts` starts `node apps/api/server.ts` against the suite's own
database, reads `task.read` over HTTP, stops it with SIGTERM, checks that the
port no longer answers, starts a new process and reads again.

### W06 coverage

`restart-http.test.ts` stops the API process, restarts the container, waits on
the database clock with nothing serving, then starts a new API process. Every
call after that goes over the socket to the new process on the API port.

| W06 claim                              | Postgres restart                                                                                   | API process restart, over HTTP                                                                                                                                                                                              | browser B6 leg (lane stack, e1d34a5)                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| task identity                          | row read back through a fresh `createApi`                                                          | `task.read`, same id                                                                                                                                                                                                        | yes: screen and `task.read` identical               |
| lineage, version, evidence pack        | ids and lineage state compared                                                                     | same in the `proposals` projection                                                                                                                                                                                          | no                                                  |
| gate and gate state                    | `id:state` compared                                                                                | same in the projection                                                                                                                                                                                                      | yes: the gate is still `pending`                    |
| gate decision chain                    | ids compared                                                                                       | ids, signatures and hashes compared                                                                                                                                                                                         | no                                                  |
| reservation, lease, attempt            | `id:state` compared                                                                                | same in the projection                                                                                                                                                                                                      | yes: a lease and a dispatched attempt cross it      |
| delegation                             | `id:live/settled/revoked` compared                                                                 | DB rows compared around the HTTP calls                                                                                                                                                                                      | no                                                  |
| receipt (handback report)              | a report minted before the restart, id compared                                                    | receipts go from 1 to 2 on one HTTP handback                                                                                                                                                                                | no                                                  |
| operation register                     | operation ids compared                                                                             | DB rows compared                                                                                                                                                                                                            | no                                                  |
| no auto approval                       | the undecided gate stays `pending` with 0 decisions                                                | a gate that lapsed while down answers 410 `GATE_EXPIRED`; 0 decisions, 0 holds, stored state `pending`                                                                                                                      | yes: the pending gate has no decision               |
| no silent cancelled-lineage resumption | the lineage is cancelled through `task.cancel`; it stays `cancelled` and its hold is not claimable | `task.cancel` answers 200 with the lineage `cancelled` and one `operations` row; a byte-identical replay adds nothing; pickup answers 409 `RESERVATION_NOT_CLAIMABLE`, no lease                                             | no                                                  |
| authorised restart (G05)               | not exercised                                                                                      | `task.restart` answers 200 with a new lineage that names the old one, version 1, a `pending` gate, 0 decisions and no hold; the old lineage stays `cancelled` and its hold still refuses a pickup; a replay adds no lineage | no                                                  |
| no duplicated proposal or hold         | byte-identical propose and decide replays add no row                                               | the same replays over HTTP add no row                                                                                                                                                                                       | no                                                  |
| handback exactly once                  | second handback 401 `DELEGATION_NOT_LIVE`, replayed pickup mints no lease                          | the same over HTTP                                                                                                                                                                                                          | the agent hands the lease back to the restarted API |
| Request Changes across a restart       | not exercised                                                                                      | version 1 sent back before, version 2 proposed after; a replay leaves versions `1,2`                                                                                                                                        | no                                                  |

A lapsed gate keeps the stored state `pending`:
`migrations/0011_runtime_gates.sql:16` says nothing expires a gate on a timer,
and `decide.ts` refuses it on the database clock (G06). Expiry is read, never
written.

**Still open, by name.** (1) The browser leg carries a pending gate, a lease
and a dispatched attempt across a restart (B6, merged at e1d34a5), proved on
the lane's own stack only. The run at the integrated candidate is with the
coordinator. B6 does not reload onto a proposal's lineage, a decision chain
or a cancelled lineage. (2) `tests/browser/restart-legs.mjs` holds the W06 (b)
browser rows for those: after a real restart, the task page draws a lapsed
gate as expired, version 2 of a Request Changes round, a cancelled lineage's
restart with the old lineage terminal, and a decision clicked on the page's
own Approve button. RESTART-LEGS committed it unrun, and nobody has run it
since. Cancellation and authorised restart are closed over HTTP: L3-CONTROLS
declared `task.cancel` and `task.restart` (d41c842), both cases run as plain
`it`, and the cancelled-lineage fixture in `walkTheOtherLineages` cancels
through `task.cancel` on the API.

## Defects found in other lanes' files

This lane found five defects and recorded each as a case that asserted the
behaviour as observed. Four are fixed on this head, and the cases now assert
the fix.

1. **Fixed: an absent `operationId` was answered untyped.** `envelope.ts`
   guarded it with `OPERATION_ID.test(...)`, which coerced `undefined` to the
   string `"undefined"`, and the caller got a plain-text 500. The guard now
   checks the type first (the `operationId` guard in
   `packages/core-records/src/commands/envelope.ts`), and
   `surface-inventory.test.ts` ("answers an absent operationId with
   OPERATION_ID_REQUIRED, like null and the empty string") asserts
   `OPERATION_ID_REQUIRED` 422 for the absent field, `null` and `''`.
2. **Fixed: five declarations answered an untyped fault.** `task.create`,
   `task.restore`, `task.purge`, `task.read` and `preset.plan` gave an
   authorised admin a 500 for a bare envelope. They now answer typed operand
   refusals (API.md, "Routes"), and `surface-inventory.test.ts` requires
   zero person-prefix untyped faults over all 35 declarations.
3. **Fixed: the mounted app did not draw the re-login path.** The web client's
   `SESSION_ENDED` now holds `AUTH_UNKNOWN_LOGIN` and `AUTH_SESSION_EXPIRED`
   (`SESSION_ENDED`, `apps/web/src/operations/client.ts`), and
   `restart-and-expiry.test.ts` ("draws the re-login path for an expired
   session, through the real client") asserts the hook fires once, carrying
   the expired code.
4. **Fixed: an agent could reach `task.comment` by the surface and not by the
   server.** `AGENT_OPERATIONS` has a `task.comment` row
   (`commands/agent-operations.ts`). The matrix's case (i) asserts the saved
   comment on the agent's own task, and `AUDIENCE_NOT_PERMITTED` for a
   `client` comment.
5. **Fixed: the command line could not report a fault.** It read every answer
   with `response.json()`, which throws on a body that is not JSON. Since
   `22530b6`, `run` in `createCli` (`apps/cli/client.ts`) reads the text and
   parses it inside a `try`, so a non-JSON answer keeps its status and its text
   and exits 4 ([CLI.md](CLI.md#output-and-exit-codes)).
   `tests/cli/cli-answers.test.ts` holds it ("a non-JSON 503 is a fault too:
   exit 4, the text printed as it came").

## Interface gaps

A gap is a proof that cannot be written without a change to a source file this
lane does not own.

- **Closed: no external reader could be minted (I09).** `enrolExternal`
  enrols R4, `shareRecord` shares a record with it, and the matrix's case (g)
  drives it (see item 2). The seed still enrols none.
- **The tenancy testing package cannot answer "is RLS on this table right now".**
  `prefix-harness.ts` exports per-prefix machinery and keeps `rolesOf` private,
  so item 4 reuses `tenancyConformance` from
  `packages/core-records/src/tenancy/conformance.ts`, the check the harness
  itself calls, and hand-writes one `pg_class` query. A small exported
  `rowSecurityOf(read, table)` would remove that last hand-written query.
- **Closed: no seeded role could `task.decide`.** When this lane ran, the
  seed gave the admin no `decide` action, so against the live stack every
  decision and so every pickup was unreachable. The seed now gives the admin
  `task:decide` (`scripts/local-seed.mjs:98`); a member still does not hold it.
- **The fixture's member and the seed's member differ.** The seed's `member`
  holds `['task:read', 'task:write', 'task:assign', 'person:read', 'settings:read']`;
  the `MEMBER_ACTIONS` that `world.ts` grants (from `tests/acceptance/cast.ts`)
  is `read`, `write`, `assign` and `comment` on `task` only. The matrix does
  not depend on it, because it reads grants back out of the `grants` table
  rather than trusting the list, but `mia` is not the same person in the two
  places. `tests/acceptance/final-r1-dbtest-cast.test.ts` now pins that
  difference: `task:comment` added and the `person` and `settings` reads left
  out. It also checks that the seeded admin holds every grant a
  `COMMAND_SURFACE` declaration asks for.
- **Closed: `lockTask` was not exported.** It is exported from
  `packages/core-records/src/commands/prepare.ts` now, and
  `tests/tenancy/production-lookup.test.ts` runs it under each mutation.
  `predicate-rls.test.ts` still hand-writes the predicate-less variant of the
  record lookup, as supplementary evidence (its header says so).
- **`SPOOFABLE_ON_UPDATE` is not exported.** `tasks-write.ts` holds `['source']`
  privately for `task.update` (and `SPOOFABLE_ON_CREATE`, `['source',
'intake_state']`, for `task.create`), so `PROVENANCE_FIELDS` in
  `protected-fields.test.ts` restates it. That is the one hand-kept fact in the
  item-3 proof, and exporting the list would close it.
- **The web client discards the HTTP status on a refusal.** `WireRefusal`
  (`apps/web/src/operations/client.ts`) carries `code`, `names` and `fixes`
  only, so the web surface can assert the code and the names but not the
  status. A 403 `SOURCE_SPOOFED` and a 422 `TRANSITION_PROTECTED` are
  indistinguishable by status to the mounted app.
- **`refuseGenericWrite` reads the legacy spelling.** In
  `packages/core-records/src/records/fields.ts` it reads the derived joined
  `owningOperation` rather than the `text[]` `owningOperations` that
  `docs/local/AUTHORITY.md` names as the model. It is not a defect, because
  both come from one array and cannot disagree. It is a new reader taking the
  legacy form, and it is why `state`'s refusal names read
  `state=task.complete task.reopen task.start`.
- **Closed: `DELEGATION_EXCLUDES_OPERATION` was missing from `AUTHORITY.md`'s
  table.** The agent prefix answers it with 403 for most declarations, and the
  table now has the row, with where the envelope raises it
  ([AUTHORITY.md](AUTHORITY.md#refusal-codes-as-l3-registered-them)).

## Suites that need a real server

Two suites spawn the real `apps/api/server.ts` on the loopback port named by
`SURFACE_API_PORT` and skip every case without it, so they are not in the
counts above and are not named for `db:conformance`:

- `tests/api/server-onerror.test.ts` proves a `DECISION_INTEGRITY` fault
  answers 500 through the server's `onError`, not 503.
- `tests/cli/mounted-cli.test.ts` drives `apps/cli/client.ts` over a real
  socket: create, assign, start, complete and reload a task, `preset.plan`,
  and a D03 cell.

Both ran green on the SURFACE-FINAL lane's stack, 7 of 7 on the DOCS-2 lane's
own stack at `8b7c6cb` (tested, lane run), and 7 of 7 serially in the
coordinator's live run at `d62f1bc`. Neither has a merge-trial run with the port
set.

The real command line is proved separately and needs no port:
`tests/cli/cli-process.test.ts` (named, 11 tests) runs `apps/api/server.ts`
and `apps/cli/main.ts` as separate OS processes over HTTP (person journey
with revisions checked in the database, board and people reads,
`SCOPE_NOT_GRANTED`, another business, an unknown verb that sends nothing, the
agent queue, pickup, heartbeat and handback, a bare agent call refused
`DELEGATION_EXCLUDES_OPERATION`, login, and the package script). See
[CLI.md](CLI.md).

Restart recovery at API startup is proved the same way:
`tests/runtime/recovery-entry.test.ts` (named, 7 tests: 1 scope-parser case
and 6 real-startup cases) starts the real `apps/api/server.ts` process on free
loopback ports with `RECOVERY_BUSINESS_KEYS`, so it needs no
`SURFACE_API_PORT`. An eligible historical hold is classified once before the
server listens, and a second start classifies nothing. A fault injected before
commit rolls back and exits 1, and the next start completes. Claimable and
unfenced live holds are untouched, only the configured businesses change, and
two racing starts release each hold once. It ran 7 of 7 in the RECOVERY-ENTRY
lane (`5878c90`), and the joint gates at `610983f` ran it green in
`db:conformance`. See [RUNTIME.md](RUNTIME.md#restart-recovery-at-api-startup).

**Run them one file at a time.** Each file spawns its own `apps/api/server.ts`
on the one port `SURFACE_API_PORT` names. Under Vitest's default file
parallelism the two servers start together, the second cannot bind
(`EADDRINUSE`), and its suite fails with "the API process did not answer" (U1
in `server-onerror.test.ts`). The coordinator's live run at `6e5a139` showed
both results: 4 passed, 1 file failed together, 7 of 7 passed serially
(`parent-observations/runs/54700f7/surface-api-port.log` and
`surface-api-port-serial.log`). Run them like this, with the stack's
`DATABASE_URL` and `DATABASE_ADMIN_URL` set and any spare loopback port:

```sh
SURFACE_API_PORT=8812 pnpm exec vitest run --fileParallelism=false \
  tests/api/server-onerror.test.ts tests/cli/mounted-cli.test.ts
```

Two separate `vitest run` invocations, one file each, also work.

## D06 and D03 on the mounted browser (D06, D03, I02, I11)

`tests/browser/d06-mounted.mjs` (`pnpm verify:d06-mounted`, beside
`verify:browser` rather than inside it) runs the in-process D06 grid again in
a real Chromium page. The person signs in through GoTrue, and the
`OperationsClient` module Vite serves to that page makes every request
(`throughClient`), against the API on a socket and a real Postgres. The grid is
not copied. The operations, keys, probe values and durable comparison come
from `tests/acceptance/d06-cases.ts`, and the positive bodies from
`role-case-bodies.ts` with their `asPerson` pointed at the page.

- **Cells:** 966. That is 35 operations × 27 top-level keys (945) plus 7
  `fields` operations × 3 installed system fields (21). The L6 packet's 872
  missing cells were counted on the older 35 × 25 grid. Every one of those
  (operation, key) pairs is in this grid.
- **What a cell asserts:** a valid control succeeds. The same valid request
  with the one field is refused with the exact code naming only that key
  (`FIELD_NOT_WRITABLE`, or `SOURCE_SPOOFED` for `fields.source` on
  `task.create` and `task.update`), and it echoes nothing. Every public table
  keeps its count and newest `xmin`, and exactly one refused audit row holds
  the attempted value. Then the request without the field succeeds under a
  fresh operation identity.
- **Per-cell receipt:** each cell writes one JSON line to
  `d06-mounted-cells.jsonl` (operation, field, placement,
  `surface: mounted-browser`, expected and actual code, names, control,
  retry, pass, head). `d06-mounted-summary.json` holds the per-operation
  applicability.
- **I02:** all 35 operations are called from the page, so each operation's
  valid control is its mounted web positive. Two need a precondition the page
  cannot make:
  - `grant.revoke`: `tests/commands/fixture.ts` `grantTo` issues its grant,
    because no page operation issues a grant.
  - `delegation.revoke`: the alpha agent's pickup on
    `/api/a/b/alpha/task/pickup` opens its delegation, because an agent is not
    a page user.
- **D03, browser column** (`d06-mounted-d03.mjs`): each of the 11
  `PROTECTED_TASK_FIELDS` is added on the wire to the task screen's own Save,
  which goes through `submitEdit`. The run asserts four things:
  - the exact code and names. Eight fields are `TRANSITION_PROTECTED` naming
    `key=owning operations`, `intake_state` included, which names
    `task.triage`. `completed_at` and `key` are `FIELD_NOT_WRITABLE`, and
    `source` is `SOURCE_SPOOFED` (403);
  - the `public.records` row is unchanged, read by the admin;
  - nothing is echoed;
  - the text the existing renderer draws (`p.field__error[role=alert]`)
    starts with the code and carries the names, owning operation included.

  One screenshot per field, `D03-<field>.png`. N3 and N4 in
  `cases-n3-n5.mjs` now also require the exact code and names, not just
  `refused`.

- **I11:** `servedIdentity` in `tests/browser/harness.mjs` fetches, in the
  signed-in page, the entry document, its module scripts, the `IN_PAGE`
  modules and every loaded `/src/` module. It prints each URL with its sha256
  and byte count beside `git rev-parse HEAD` and whether the tree was dirty.
  The same list goes into `MANIFEST.json`, together with a sha256 for every
  PNG. The served modules are Vite's dev transform of the source (the local
  slice is served by Vite dev), not a `vite build` bundle.

**Lane runs on `b1fd9f3`** (tested, lane run, own stack: Postgres on 54399,
API 8799, Vite 5199):

- **Grid:** 939 of 966 cells passed on both runs (118 s and 139 s).
- **D03:** 11 of 11 on both runs.
- **Not proved:** the 27 `delegation.revoke` cells. Each failed at its
  precondition, before its control, because the alpha agent's pickup
  answered 401 `AUTH_UNKNOWN_LOGIN`. The lane's
  `.local/synthetic-agents.json` password for the alpha agent's login is not
  the one the shared GoTrue holds (`invalid_credentials`). Another lane
  created that user, and `scripts/local-seed.mjs` keeps an existing agent
  user's password rather than resetting it. These cells are unproved on
  the mounted browser, not passed.
- **`verify:browser` on the same stack:** 84 of 85. B6 threw at the same
  agent pickup.

## Delegated-pickup proof group: cases added for the freeze

Three suites close cases that the source-only freeze mapping found missing. Each
went red under a disposable mutation and green after it. "Tested" here means the
same thing as in the rulings table below.

- **Grant chain:** `tests/authority/grant-chain.test.ts`. A root, a derived and a
  grandchild grant across two manager levels; `GRANT_WIDENS` and `GRANT_DEEPENS`
  on each of their grounds. `grant.revoke` on the root refuses the grandchild's
  and the middle manager's next call while a sibling chain reads on, with one
  audit row per call.
- **Bare handback replay:** `tests/api/agent-bare-handback-replay.test.ts`. A
  credential-free replay of a settled `task.handback` answers 403
  `DELEGATION_EXCLUDES_OPERATION` with its names and fixes (the wire refusal has
  no reason field), nothing of the receipt and no state change. The credentialed
  replay returns the stored receipt.
- **Decision never delegated, in the schema:**
  `tests/db/decision-never-delegated.test.ts`. On an ordinary write that names
  `decide`, `delegations_actions_known` (`0008:188`) is the constraint Postgres
  reports; `delegations_never_decide` (`0008:186`) is the named second barrier
  and is shown refusing alone. `gate_decisions.decided_by_person_id` is not
  null (`0012:36`).

## Tenancy wrapper mutations and decision-chain negatives

Three suites for ledger T04, T05 (`:49`, `:50`, `:105`) and G02 (`:87`), proved
at `3c7928d`. Each negative went red with its expectation inverted, and each
suite is green as committed.

- **Wrapper mutation:** `tests/tenancy/wrapper-mutation.test.ts`. On a
  disposable source copy (`tests/support/source-mutant.ts`), the mutant makes
  the `set_config(..., true)` line in `withBusinessOn` (`tenancy/database.ts`)
  session-wide (T04 a) and moves it before `begin` (T04 b). `task.create`,
  `task.update`, `task.read` and `task.board` then fail the capture's shape check:
  (a) at `sessionWide` and (b) at `outside`, where (b) also fails closed with 500
  and a rollback. An unmutated copy runs green in the same run after both
  mutants. T04 (c): the `DECISION_INTEGRITY` read, captured on the shipped
  wrapper, is begin, local setting, work, `rollback`, with nothing outside. T05:
  the session-wide mutant, run through pooled-crossover's sequence on one
  backend, leaves A's id at the `pooled-crossover.test.ts:168` read and B's at
  the `:206` read. The restored wrapper leaves `''` at both. A session-wide
  setting made inside a transaction that rolls back is undone with it, so
  `:206` goes red on the previous commit's leftover, not on A's rollback. The
  suite shows this on a fresh backend.
- **Signature only:** `tests/reads/decision-signature-only.test.ts` (G02 a). Only
  `gate_decisions.signature` is altered. With the stored hash kept, and with the
  unkeyed chain recomputed over the new signature, the HTTP read answers 500
  `DECISION_INTEGRITY` and the direct read throws `signature does not verify`.
  With the original signature and hash restored, the read answers.
- **Decision seq race:** `tests/runtime/decision-seq-race.test.ts` (G02 b). Two
  approvals on two tasks, both with cap room, are parked on the business chain
  lock on two backends behind a held lock and then released. Both apply, at seq
  2 and 3 after an existing seq 1, each `prev_hash` the previous row's `hash`,
  in queue order, and the production read verifies both tasks.

## L6 proof gaps: runtime schedules and refusals (DB-PROOF-GAPS-B)

Four suites close the L6 rows G04, G05, W02 (b, c), W04 (schedules) and W05
(`parent-observations/runs/6f15252/L6/DISPOSITIONS.md`) under root rulings 3,
4 and 6. Each runs on a real database and is named in `tests/db/named-suites.json`.

- **Schedules:** `tests/runtime/l6-schedules.test.ts`. A third connection holds
  the cap row; the first racer is seen parked on it and the second seen waiting
  before it lets go. W02 (b): the original pickup and a same-operationId retry
  in flight leave one lease, one delegation and one hold with identical handles.
  The retry that loses the identity claim is rolled back and replays on the
  caller's retry, because the agent entry does not retry that loss itself. W04:
  pickup against `task.cancel` in both orders, and two pickups over an expired
  lease. Each ends with one outcome, the hold classified at most once (the
  envelope's held total equals its held reservations) and no reservation
  revived.
- **Cases:** `tests/runtime/l6-cases.test.ts`. G04: a held, unleased
  reservation superseded by a real `task.propose` is `RESERVATION_NOT_CLAIMABLE`
  with no runtime row changed and one refused audit row. G05 ruling 3: a
  retried restart identity returns the same child, a different identity on the
  restarted parent is `TRANSITION_NOT_PERMITTED` and audited, and a terminal
  child restarts. G05 ruling 4: a parentless proposal beside a rejected or
  cancelled lineage opens a live lineage with no provenance and changes none of
  the old lineage's gate, hold or lease. W05: no room in the envelope under a
  cap with room is `BUDGET_UNAVAILABLE`, with no decision, reservation or
  envelope change.
- **Restart expiry:** `tests/api/restart-expiry-bound.test.ts`. Through the
  route, `task.restart` at 604800 seconds is accepted with the gate closing
  seven days out; 604801 is `FIELD_VALUE_INVALID`, audited, with no lineage.
- **Heartbeat maximum:** `tests/commands/heartbeat-bound.test.ts`. Through the
  agent route, `leaseSeconds` of 3600 renews the lease and its delegation to it;
  3601 is `FIELD_VALUE_INVALID` naming `leaseSeconds`, audited, and moves neither.

## L6 acceptance rows: I03, I04 and I07 (ACCEPTANCE-ROWS)

These close L6 rows I03, I04 and I07 under root ruling 3 at dd30aa8 and root
ruling 9 at d62f1bc (`parent-observations/runs/6f15252/L6/DISPOSITIONS.md`).
The three suites below are named in `tests/db/named-suites.json`. The lane
also named `i10-inflight` and `board-not-found`, the two that L6 section 9
item 13 left unnamed. Tested in the lane run on `8819fac`.

- **I03, 35/35:** `role-case-matrix.test.ts` (c)/(d). The swap compares 16
  operations, and each of the other 19 has one `cd-not-applicable` row, with
  its reason taken from `tests/acceptance/cd-alternatives.ts`. The 10
  identifier-bearing rows each name the executed identifier-negatives case
  that compares a foreign and a fabricated operand by status and raw bytes.
  The 9 target-free rows say "not applicable: target-free (SC2)". A
  declaration with no row throws. The matrix is 384 rows: 338 pass, 0 fail,
  46 named exceptions. Only the 19 rows moved the exceptions (27 before).
- **SC2 audit, 9/9:** `identifier-negatives.test.ts`, target-free case. Each
  aimed probe (`recordId` naming bravo's task) is `COMMAND_BODY_INVALID`,
  writes one refused audit row in alpha (actor, command, operation, code and
  digest only) and writes none in bravo.
- **I04, 26/26:** `identifier-timing.test.ts`. Each identifier-bearing
  operation gets 5 discarded warm-up pairs, then 30 alternating foreign and
  fabricated pairs, and every sample must be the expected refusal. A pair of
  distributions is outside only when both of two tests fail: a two-sided
  Mann-Whitney U with |z| <= 3.29, and a median difference within max(2 ms,
  20 percent). Medians ran 7.9 to 13.5 ms, with a largest |z| of 2.38 and a
  largest difference of 1.35 ms (`task.decide`). Non-vacuity: a 15 ms delay on
  one arm of `task.read` is flagged (z = -6.65). The timing is in process,
  not over a network.
- **I07, one live gate:** matrix case (j). A real `task.propose` gives gate G
  at version V, still pending. The agent (R5), under its live credential,
  decides {G, V} and gets `DELEGATION_EXCLUDES_DECISION`, and G stays pending
  with 0 decisions. The admin (R1) then decides the same {G, V}, and it
  applies as one signed `gate_decisions` row by the admin. Both rows carry G,
  V and the deciding actor, and the run prints an `I07 receipt:` line with
  both identities.

## Retry bounds, grant-expiry intake and the proposal snapshot

RETRY-BOUNDS, GRANT-EXPIRY-INTAKE and PROJECTION-SNAPSHOT merged jointly at
`b483399`. Every count here comes from the lane's own run on its own Postgres.
The joint gates at `b483399` then passed, with `pnpm test` at 5,210 passed and
24 skipped and `db:conformance` at 107 named suites, 4,713 of 4,713. That run
includes every case below. `retry-bounds`, `projection-snapshot` and
`proposal-snapshot` are newly named in `tests/db/named-suites.json`;
`historical-handback-intake` was already named.

- **Retry bounds:** `tests/runtime/retry-bounds.test.ts`, 3 tests, 3 of 3 on
  three runs in a row at `baba43d` and once at `867f391` after the title
  change. The test wraps the command's connection, records every transaction
  and statement, and forces each schedule between two statements, so no
  timing is guessed.
  - Person entry, double loss. `task.cancel` loses its discovery on both
    attempts: between each attempt's discovery and its first lock, another
    connection proposes and approves a revision of the lineage, so the recheck
    under the locks throws `AffectedSetChanged`. `executeCommand` rejects with
    it after two command attempts and one separate failed-audit transaction,
    with no third attempt. Nothing commits: the lineage stays live, no
    reservation is classified `lineage_cancelled`, there is no `operations`
    row, and the audit holds one `failed` event. Undisturbed, the same body
    then applies.
  - Agent entry, double collision, a staged control. No schedule reaches a
    second `operations_identity_key` loss: the retry reads the register by the
    constraint's exact key, and the register is append-only, so the retry
    replays the first winner. The test stages the collision instead. Before
    each attempt's register insert, the owner connection commits a row under
    the attempt's actor and operation id, and after the loss it removes that
    row under `session_replication_role = replica` to pass the append-only
    trigger. `executeAgentCommand` rejects with 23505 on
    `operations_identity_key` after two attempts, with nothing committed and
    no audit event of any outcome. The test title says "(staged control)",
    and the lead ruled that the case stays.
  - `grant.revoke` lock trace. While a pickup is parked on the cap row, the
    revocation waits on the pickup's transaction for the grant row.
    `grant.revoke` locks its grant row `for update` before any runtime lock,
    and `task.pickup` holds `for share` on its covering grants before its own.
    The two serialise on the grant row, so a pickup cannot grow a revocation's
    affected set between discovery and locks. The case asserts the revocation
    applies in one transaction, its first locking statement is the grant row,
    and at least one waiter is observed.
  - Red: a throwaway edit, since reverted, widened both entries' bound to three
    attempts, and the first two cases failed.
- **Grant-expiry intake:** `tests/runtime/historical-handback-intake.test.ts`
  gains a `grant-expired` path of 3 cases: 13 of 13 at `91cda99`, and 2 failed
  at `9f61aa6`. The person's only task write grant expires while the agent's
  delegation is still live. The agent's handback answers
  `DELEGATION_NARROWED` and keeps exactly one `retained` report. Nothing is
  revoked, the delegation stays live and its `revocation_cause` stays null. A
  same-identity replay adds no row, altered operands get
  `OPERATION_ID_REUSED`, and a new identity appends a second row. Another
  agent, another business, a forged credential, a foreign or unknown lease,
  another task's lease and a wrong fence each retain nothing. A fault after
  retention rolls back, and the retry retains one. The resolver is
  `resolveNarrowedDelegation` in `delegations.ts`, reached from
  `retainLateHandback` in `agent-late-handback.ts`.
- **Proposal snapshot:** `tests/reads/projection-snapshot.test.ts`, 4 tests,
  and `tests/surfaces/proposal-snapshot.test.tsx`, 1 test, both green at
  `163969b`. At `9f61aa6` 3 of the 4 and the surface test were red.
  `readTaskProposals` now takes versions, gates and reservations in the
  verifier's one statement (`readVerifiedProjection` in
  `verified-decisions.ts`). A real approve lands before or after that
  statement, on the first decision and on round 2 after Request Changes, and
  the answer is wholly decided or wholly pending, never a pending gate beside
  its own decision. The read issues one statement, and a deleted or tampered
  decision is still `DECISION_INTEGRITY`. The surface test serves that
  projection through `OperationsClient` and `TaskDetailScreen`: the decided
  view draws no approve or reject control, and the pending view draws both,
  enabled. `tests/reads/decision-snapshot.test.ts` now pauses only after
  statement 0, a declared one-line edit the lead accepted.

## The Sol 6 fixes and the API root

SOL-RUNTIME-FIX and SOL-AUTHORITY-FIX merged with DOCS-4 at `06ab232`, and the
joint gates there passed. REFACTOR-API-ROOT reached the branch inside
SWEEP-API, which merged at `056aa7c`. The joint gates there were red on
`refusal-catalogue.test.ts`, fixed forward at `d31afc1`. They passed at
`9ddfa09`, at `ca0b79c`, at `67fa922`, at `e84add2`, at `9abf30d` and at the
integrated head
([Current counts](#current-counts-and-what-they-are)). Each test count below
is the `it(` calls in the file, with parametrised tables expanded, read from
the file, not from a run.

- **Cap and clock, SOL-RUNTIME-FIX.**
  `tests/runtime/cap-exact-and-post-lock-clock.test.ts`, 4 tests, through the
  command entry. A USD version under an AUD cap is `CAP_BINDING_MISMATCH` and
  nothing moves. A cap of 2^53 + 1 fills to the exact minor unit, and one unit
  more is `BUDGET_EXHAUSTED`; the test reads every total from SQL as text. A
  decide parked on its gate and a heartbeat parked on its lease until the
  database clock passes the deadline answer `GATE_EXPIRED` and
  `LEASE_EXPIRED`, because each reads the clock after its locks are held.
- **Lease expiry and successor bounds, SOL6-RUNTIME-FIX-2.**
  `tests/runtime/lease-expiry-post-lock-clock.test.ts`, 3 tests (RUNTIME-1).
  A handback that waited on the cap past its lease's expiry is `LEASE_EXPIRED`
  with its report retained. A pickup that waited the same way fences the
  expired claim. The same agent replaces its own claim after waiting past the
  delegation's expiry. `tests/runtime/successor-bounds-exact.test.ts`, 1 test
  (RUNTIME-2): with 2 left in the cap, a successor ceiling of 4 is refused and
  a ceiling of 2 is accepted. Tested (merge trial, `06ab232`).
- **R4, spend and the agent's operation id, SOL-AUTHORITY-FIX.**
  `tests/authority/non-member-grants.test.ts`, 3 tests. Record-scoped
  `comment` and `write` grants alone give no standing, so every call is
  `AUTH_NO_MEMBERSHIP`. Beside a read share they write no internal comment
  (`AUDIENCE_NOT_PERMITTED` 422) and no update (`SCOPE_NOT_GRANTED` 403). A
  read share alone writes no comment, and a held `comment` grant writes a
  client one. `tests/runtime/historical-handback-intake.test.ts` sends
  `actualMinor: 1` on its narrowed, retired and grant-expired paths: each is
  `ACTUAL_EXPENDITURE_UNSUPPORTED` 422 with nothing retained, and a `null`
  actual is still retained. `tests/commands/agent-operation-id.test.ts`, 5
  tests: a number, an array, `null` or an absent agent `operationId` is
  `OPERATION_ID_REQUIRED` with no register row, and the string registers.
  Tested (merge trial, `06ab232`).
- **Admission and the operation id at the boundary, REFACTOR-API-ROOT and
  SWEEP-API.** `tests/api/admission-enumeration.test.ts`, 17 tests through
  `composeApi`. On both prefixes, for a valid and a malformed body, a foreign
  business key and a fabricated one answer the same raw bytes, and an expired
  bearer is `AUTH_SESSION_EXPIRED` 401 for any key. A malformed-body attempt
  is recorded only in the business that resolved. A non-string agent
  `operationId` is `OPERATION_ID_REQUIRED` 422 with no operation row, and a
  string one reaches the queue. `tests/api/agent-operation-id.test.ts`, 6
  tests: the agent boundary hands the envelope `operationId` exactly as the
  JSON carried it, and a number, an array, `null` or an absent field is
  `OPERATION_ID_REQUIRED` 422 with nothing registered. Tested (SWEEP-API lane
  run on `3737480`, which includes REFACTOR-API-ROOT; merge trial, `9ddfa09`
  and `ca0b79c`).

## Engineering rulings, and how far each is proved

The build's root ruled on contract questions the lanes raised at `dd30aa8`,
`4ccc94c` and after the item-5 triage. Each ruling is an engineering reading of
an existing clause, not a new product decision, not a waiver and not
acceptance. The status column uses the labels above; "tested" means a merge
trial ran the named suite green, nothing more.

| Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Clause                                                  | Status                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| An installed system field named at the top level of a body is refused `FIELD_NOT_WRITABLE` by name, from the installed field metadata, on every route. Nested keys stay the operation's own, and `source` stays `SOURCE_SPOOFED`. No general unknown-key policy.                                                                                                                                                                                                                                                                                                                  | D06, T1-N4                                              | tested (merge trial): `d06-generated`, `d06-agent`, `boundary-system-fields`            |
| A foreign and a fabricated gate both answer public `NOT_FOUND`, byte for byte the same, audited in the caller's business. Tests compare raw bytes; normalising identifiers out of a comparison is not allowed.                                                                                                                                                                                                                                                                                                                                                                    | minimum contract 8.2 case 1                             | tested (merge trial): `identifier-negatives`                                            |
| A read that takes no target refuses an unsupported identifier such as `recordId` with `COMMAND_BODY_INVALID`, as the command path does. Reads that do take one (`task.read`, `task.board`) are checked per operation.                                                                                                                                                                                                                                                                                                                                                             | contract ledger SC2, I03                                | tested (merge trial): `audit-per-operation`, boundary suites                            |
| A body that is not a JSON object writes one durable admission refusal (`authentication_attempts`, `COMMAND_BODY_INVALID`, subject digest only) once the bearer and business are resolved, and no `audit_events` row. No body or credential is stored.                                                                                                                                                                                                                                                                                                                             | ledger I13                                              | tested (merge trial): `audit-per-operation`                                             |
| A person's `session.capabilities` counts only live, unexpired, parent-covered grants; a member with none gets `SCOPE_NOT_GRANTED`. After pickup an agent's answer is bounded by the current delegation and person intersection.                                                                                                                                                                                                                                                                                                                                                   | ledger I05, I12                                         | tested (merge trial)                                                                    |
| A bare agent call outside `task.queue` and `task.pickup` is `DELEGATION_EXCLUDES_OPERATION`, and `task.decide` is `DELEGATION_EXCLUDES_DECISION`; a bare handback replay gets the same exclusion with no receipt content. The lost-response pickup replay is the one exception.                                                                                                                                                                                                                                                                                                   | minimum contract 8.2 case 9, ledger I12, T3             | tested (merge trial)                                                                    |
| A lost pickup response is recovered by an authorised retry that returns the same credential, derived under a dedicated delegation key after current-rights and binding checks. Ordinary replay never rotates a credential. Legacy random credentials cannot be recovered and are labelled so ([RUNTIME.md](RUNTIME.md)).                                                                                                                                                                                                                                                          | T3                                                      | tested (merge trial); the custody boundary is owed to the independent correction review |
| A present `null` `leaseSeconds` or `report` is `FIELD_VALUE_INVALID`; omitting either keeps the default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | T3, T4                                                  | tested (merge trial)                                                                    |
| **D03 precedence.** On `task.update`, any `intake_state` in `fields`, `accepted` included, is `TRANSITION_PROTECTED` naming `task.triage`. The specification's T1-N3 and ledger row D03 take precedence over the older minimum-contract 6.1 wording, which answered `SOURCE_SPOOFED`. `task.create` keeps `SOURCE_SPOOFED` for `source` and `intake_state` (minimum contract, create rules).                                                                                                                                                                                      | T1-N3, ledger D03, minimum contract 6.1                 | tested (merge trial): `protected-fields`                                                |
| The external party's task page draws only the server's shared projection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | R4                                                      | tested (live run, `d62f1bc`): `verify:browser` 88 of 88; not run since                  |
| When a grant's loss revokes a delegation, the server records the cause (`authority_lost`), and the bound agent's next call on its unexpired credential is `DELEGATION_NARROWED`. Nothing is reactivated; explicit revocation, expiry and settlement keep `DELEGATION_NOT_LIVE`.                                                                                                                                                                                                                                                                                                   | minimum contract 8.2 case 6, ledger I08, T5             | tested (merge trial): `authority-loss-narrowed`, `runtime-residuals`                    |
| New decisions sign round, decision time, acting actor and their chain context in a versioned payload (v3). Older rows are verified for what they signed and never rewritten.                                                                                                                                                                                                                                                                                                                                                                                                      | T2                                                      | tested (merge trial): `decision-v3`                                                     |
| `task.purge` reads the caller's business's `retention_window_days` inside the serving transaction and purges trash older than that window by the database clock; a body `olderThanDays`, any value, is `COMMAND_BODY_INVALID` 400 with no mutation and one refused audit row. No default, floor or ceiling is applied. Source interpretation, recorded as root ruling 2's: consuming the stored setting completes the L3 retention contract for this retained operation. It is not a claim that Nathan moved Q46 forward, and it does not discharge the other G5 completion rows. | SPEC 14.3, SPEC:319, C12-5 Q46, ledger L3 retention row | tested (merge trial since `6e5a139`; a `db:conformance` named suite): `purge-retention` |
| A read whose decisions fail to verify is a fault (`DECISION_INTEGRITY`, 500) that rolls back, not a committed refusal, so no tamper audit row is kept.                                                                                                                                                                                                                                                                                                                                                                                                                            | TC11                                                    | tested (merge trial); the live `onError` probe is owed at the final restart             |

## Deferred limits

These are limits of the first slice, recorded so nobody reads them as done.
None is a waiver.

- **Preset operand collision.** Preset install is outside the first slice. A
  future planner must refuse a system-field key that equals a top-level operand
  name.
- **Cross-installation isolation on a shared Postgres cluster.** The
  `ops_astro_app` role is cluster-wide and `PUBLIC` keeps `CONNECT` by
  default. Two installations on one cluster are not proved isolated from each
  other; a shared-cluster deployment needs its own proof.
- **v1 and v2 decision rows.** Their round, decision time, lineage, acting
  actor, id, sequence and previous link sit only in the unkeyed chain link. An
  owner-level writer who recomputes every later link can change them
  undetected. The proposal read labels each item with `linkVersion` and lists
  what the signature covers in `signedFields`.
- **Removing the newest decisions.** Deleting the tail of a business's chain
  leaves a shorter chain that verifies. v3's signed previous link protects the
  middle, not the tail; the gate and lineage cross-checks are the only defence
  there.

## Open for the owner

These two are open for Nathan. Nobody has decided them. The two protected
storage migrations SOL-RUNTIME-FIX proposed are no longer on this list: Nathan
approved both (OWNER-CARD section 6), and they are written as 0024 (a cap and
its envelope in one currency) and 0025 (the aggregate cap ceiling at commit)
([RUNTIME.md, "Why the money is two columns"](RUNTIME.md#why-the-money-is-two-columns)).

- **The R4 client-comment ruling.** An external party holding an explicitly
  provisioned comment grant may write a client-audience comment and nothing
  else, and a read share alone writes nothing. That is the lead's ruling, not
  Nathan's, and he may overturn it with an empty `EXTERNAL_WRITES` in
  `commands/prepare.ts`
  ([AUTHORITY.md, "The external party (R4)"](AUTHORITY.md#the-external-party-r4)).
- **U7 T10, stopping without confirmation.** Either a one-click "Stop the work
  here" with no in-chat confirmation stands, or AW-05 draws a confirm
  dialogue. The U7 score (events log, 2026-09-23T23:19:45Z) left U7
  undischarged and named this as Nathan's item. Either answer clears it
  without re-scoring.

## What is not here

Each is named so the unfinished work stays countable.

- **No exported share operation.** The tests issue R4's share through
  `shareRecord`; no route calls it ([API.md, "Open items"](API.md#open-items)).
- **The one statement outside a transaction.** The runtime connection's only
  statement outside a transaction is the `postgres` driver's per-connection
  `pg_type` array lookup (`fetch_types`), which `statement-capture-full.test.ts`
  asserts exactly. Turning `fetch_types` off in `tenancy/database.ts` would
  remove it. That is a product decision nobody has made yet.
- **The heartbeat's bounds are unconfirmed.** `schedules-heartbeat.test.ts` now
  tests the 8-hour lifetime total at the boundary and just past it. The bounds
  themselves are 1 hour a beat (`MAXIMUM_RENEWAL_SECONDS`) and 8 hours in all
  (`MAXIMUM_LEASE_LIFETIME_SECONDS`), both in
  `packages/core-runtime/src/heartbeat.ts`. They are lane choices still
  awaiting root or owner confirmation
  ([RUNTIME.md](RUNTIME.md#the-work-controls)). Root ruling 6 at `dd30aa8`
  does not cover them. It settles bare agent calls and replay codes only, and
  the same rulings file leaves the agent's comment audience preference
  "pending separately".
- **Reports are stored.** They are in `public.handback_reports`
  (`migrations/0018_runtime_handback_reports.sql:24`). The restart section
  above says which report identities the restart proof compares.
