<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The assembled proofs, as lane L5 built them

`tests/acceptance/` is one directory with one job: take the mechanisms the
other lanes built and ask, through the surfaces a caller actually has, whether
they hold. Nothing in it is a plan and nothing in it is a count of
declarations. Where a proof could not be written, this file says so by name.

## Current counts, and what they are

Each count below carries one of three labels:

- **implemented**: the code or test is on the branch, and no run is claimed
  for it;
- **tested (merge trial)**: the named command passed on the integration
  trial of a merge. This is a run, not a review;
- **accepted**: a review recorded it against a head.

**Nothing below is accepted.** The last evidenced milestone is `74d583c`. Its
evidence, including the review reports and the source-to-route manifest, is
kept with the build run under `runs/74d583c`, outside this repository.
`cca3c89` has merge-trial evidence only: each lane merged since `74d583c` was
merged with the commands below run on the integration trial, and nothing more.
The final live verification at `cca3c89` is owed and has not been run: reseed
the local database (the live one still stands at migration 0020, so 0021 to
0023 apply then), restart the API on the merged tree, then `verify:slice`,
`verify:browser` and the restart proof.

| What                                                                                                             | Count                                                                 | Label                           |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------- |
| `typecheck`, `lint`, `format:check`, `spdx`                                                                      | green                                                                 | tested (merge trial, `cca3c89`) |
| `pnpm test`                                                                                                      | 5,102 passed, 19 skipped                                              | tested (merge trial, `cca3c89`) |
| `tests/acceptance`                                                                                               | 3,846 passed, 11 skipped                                              | tested (merge trial, `cca3c89`) |
| `db:conformance`                                                                                                 | 78 named suites (74 invariant, 4 conformance), 865 of 865             | tested (merge trial, `cca3c89`) |
| `d06-generated.test.ts`, `d06-agent.test.ts`                                                                     | 3,706 of 3,706: 2,901 for `d06-generated`, 805 for `d06-agent`        | tested (lane run on `a3d0afe`)  |
| `role-case-matrix.test.ts` (item 2)                                                                              | 363 rows: 336 pass, 27 named exceptions, none missing coverage        | tested (lane run on `cca3c89`)  |
| `verify:browser`, including the in-flight, R4 and surface-final rows                                             | none at `cca3c89`                                                     | implemented; not run            |
| `verify:d06-mounted` ([D06 and D03 on the mounted browser](#d06-and-d03-on-the-mounted-browser-d06-d03-i02-i11)) | 939 of 966 cells, D03 11 of 11; 27 `delegation.revoke` cells unproved | tested (lane run on `20363eb`)  |
| The restart proof ([item 5](#item-5-the-restart-proof-w06-as-one-named-run))                                     | skipped in the counts above                                           | not run at `cca3c89`            |

The 19 skipped in `pnpm test` include the suites that spawn the real
`server.ts` and skip without `SURFACE_API_PORT`
(`tests/api/server-onerror.test.ts`, `tests/cli/mounted-cli.test.ts`), and the
restart cases, which skip without their disposable container. The named-suite
list and why those stay unnamed are in
[database-conformance.md](../agents/database-conformance.md).

`d06-generated.test.ts` executes 2,898 cells and three plain tests. The cells are
35 operations × 27 top-level keys × API, CLI and web (2,835: the 22
`SYSTEM_OWNED_FIELDS` plus the installed system fields, from `TOP_LEVEL_FIELDS`
in `d06-cases.ts`), plus 7 `fields` operations × 3 installed system fields on
each of the three surfaces (63). The first two plain tests read the installed field
metadata and list the operations whose bodies carry record fields. That is the
old 2,375 against 2,373 settled: at `9221c29` the file ran 2,373 cells and the
same two tests, 2,375 in all. Every one of the 2,898 cells runs between a
succeeding positive control and a succeeding clean retry on the same work,
and a third plain test asserts that from the executed tally. Person
`task.pickup`, `task.heartbeat` and `task.handback` included: they run on
the person's own work (EX-01, `handlers.ts:102-112`), a fresh approved
reservation or a lease the person's own pickup took, where until
PROOF-CLOSURE their 243 cells sent fabricated ids with no control and no
retry. `d06-agent.test.ts` holds the contract and
exclusion cells for the agent route, including the top-level system-field
keys, which the agent route now refuses `FIELD_NOT_WRITABLE` too.

The in-flight half of I10 is `tests/acceptance/i10-inflight.test.ts`. A read
is held at admission (after `effectiveGrants`) in its open transaction while
`grant.revoke` commits over HTTP. The read finishes with its content, and the
next call is `AUTH_NO_MEMBERSHIP` (R4 on a `shareRecord` share) or
`SCOPE_NOT_GRANTED` (a member on a record grant). The overlap is shown by
`pg_stat_activity` and the audit `seq` order.

## How to run them

```sh
export PATH=<toolchain>/node-v24.21.0-darwin-arm64/bin:$PATH
set -a && . ./.local/db.env && set +a      # a real Postgres, migrated
pnpm exec vitest run tests/acceptance --fileParallelism=false
```

**`--fileParallelism=false` is not optional, and the reason is a real one.**
Every file here builds its own throwaway database, but they share one Postgres
_server_, and `restart-and-expiry.test.ts` restarts that server's container. Run
in parallel, the restart terminates the sibling suites' connections and they
fail with `terminating connection due to administrator command` and
`ECONNREFUSED` — a failure that says nothing about the product. Run
sequentially, all five files pass. Vitest's file parallelism is set in
`vitest.config.ts`, which this lane does not own, so the flag is the honest
answer rather than a config change made from outside its owner.

`.local/db.env` points at a disposable Postgres of the lane's own. With
`DATABASE_URL` unset every file in the directory skips itself and says so on
the console rather than passing empty, because a proof that quietly ran nothing
is worse than one that did not run.

The measured counts each run writes are in `.local/l5-inventory.txt` and
`.local/l5-matrix.tsv`, which are gitignored: the evidence belongs beside the
run, not in the tree.

## What is being driven

Every case runs **in process against the real application**. `tests/acceptance/world.ts`
builds the Hono app from `apps/api/app.ts`'s `createApi` with the real
database, the real `executeRead`, the real `executeAgentCommand` and the real
GoTrue-shaped verifier — the same composition `apps/api/server.ts` binds a port
to — and drives it through `app.fetch`. There is no network and no API server,
and nothing below the boundary is substituted.

`tests/api/boundary.test.ts` stubs the database on purpose, because its
questions are the transport's. The questions here are the other half — whether
a foreign read really refuses, whether a protected field really does not move —
and a stub would make every one of them unfalsifiable.

The bearers are signed in the suite with the suite's own secret rather than
minted by GoTrue. `createSupabaseVerifier` verifies an HS256 token against a
deployment secret; a token signed with that same secret is the same token to
every line of product code, and the subject it carries is a real row in
`logins`. The cast is `scripts/local-seed.mjs`'s cast by name and by role —
`ada` admin, `mia` member, `noah` member with no grant, `orphan` a verified
login with no membership, `bea` a member of the other business — with an agent
actor written the way the seed writes one. The suite does not use the seed's
external party (R4): `enrolExternal` in `world.ts` makes its own, a person of `alpha` with a
login and no membership, and `shareRecord` gives it its share. The seed itself
is not imported: it needs GoTrue and it writes into the running slice's
database.

## The proof files

| File                        | Covers                                                    | State                |
| --------------------------- | --------------------------------------------------------- | -------------------- |
| `world.ts`                  | the shared fixture; not a proof                           | —                    |
| `surface-inventory.test.ts` | item 1, the exported-surface inventory (I02–I06)          | green, 10 cases      |
| `role-case-matrix.test.ts`  | item 2, the six roles and nine cases (SPEC 8, T1h, N1–N7) | see the matrix below |
| `protected-fields.test.ts`  | item 3, the protected set on three surfaces (D02–D04)     | green, 38 cases      |
| `predicate-rls.test.ts`     | item 4, the four-state predicate/RLS mutation proof (I14) | see below            |
| `external-party.test.ts`    | R4 over HTTP: the shared read and nothing else (I01, I09) | green, 5 cases       |

## The per-file cap, and why two files are harnesses

`scripts/pr-size.mjs` blocks at a per-file cap of 400 changed lines, and its
own error text says no label lifts that cap. `restart-and-expiry.test.ts`
reached 436 and was split rather than trimmed, because SPEC section 6's T1h row
is the repository's answer to exactly this situation — **split the file, not
the change** — and it names the two things not to do: delete the comments that
say why each assertion is the assertion, or add the file to the gate's
generated list. Neither was done.

`world.ts` and `restart-harness.ts` assert nothing about the product. A failure
in either is a broken fixture; a failure in a `.test.ts` file is a finding.
That is also why neither belongs in `tests/db/named-suites.json`.

**The lane as a whole is over the 400-line total** — it is a test directory, and
the total is what the coherence waiver exists for. It is recorded here rather
than worked around, and it is the coordinator's to decide at landing time.

## Item 1: the inventory

The enumeration is **generated from `COMMAND_SURFACE` itself**. There is no
list of operation names anywhere in the file, which is SPEC section 8's first
property: an endpoint added without a case fails the build, and a hand-kept
list would have put the drift in the place least likely to be read.

**Every count below is written by the run, not kept here.** The numbers are in
`.local/l5-inventory.txt` and `.local/l5-matrix.tsv`, which the suites append to
as they measure; the figures quoted in this file are the last observed values
and the files are what to read. That is the same reason the enumeration is
generated: L3-PART-B-2 took the table from 28 declarations to 30 and from 5
reads to 7 between this lane's base and its merge, and **both rows arrived with
no edit to the proof**.

Last measured on branch `slice/matrix-docs`, from `local/working-slice` at
`88f78fe`, on 23 September 2026:

| Count                                                 | Measured                    |
| ----------------------------------------------------- | --------------------------- |
| Declarations                                          | **35** — 28 writes, 7 reads |
| Reachable on the person prefix `/api/b/:businessKey`  | **35 of 35**                |
| Reachable on the agent prefix `/api/a/b/:businessKey` | **35 of 35**                |
| Reachable through `apps/cli/client.ts`                | **35 of 35**                |
| Reachable through the web client's `read()` verb      | **7 of 7 declared reads**   |
| Declared and not landed                               | **none**                    |
| Person-prefix untyped faults                          | **none**                    |

Web `read()` reach: 7 of 7 declared reads; none reachable only through
`mutate()`. The five new rows are L3-CONTROLS' support controls.

Reachable means **routed, not permitted**: the request arrives at the operation
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

**363 rows: 336 pass, 27 named exceptions, zero failures**, as
`.local/l5-matrix.tsv` recorded them in the DOCS-2 lane's run of
`tests/acceptance` on its own Postgres at `cca3c89` (tested, lane run). The 27
are 4 executed alternative and 23 not applicable; no row is missing coverage.
At 74d583c it was 331 rows, 296 pass and 35 exceptions: 9 executed
alternative and 26 missing coverage. On `slice/capabilities` it was 330 pass,
6 executed alternative, 23 not applicable and 4 missing coverage: the admin's
`task.pickup` and the member's `task.pickup`, `task.handback` and
`task.heartbeat`. PERSON-WORK's person route and OWN-LEASE-SCOPE's
record-scoped work authority closed those four.

| Case                                                             | Rows |
| ---------------------------------------------------------------- | ---- |
| (a) own-business permitted — the positive control                | 35   |
| (b) foreign business in the path                                 | 35   |
| (c) foreign record id                                            | 16   |
| (d) fabricated id                                                | 16   |
| (e) no grant                                                     | 140  |
| (e) member positive: each pair a granted member holds            | 23   |
| (f) grant revoked since the last read (I10)                      | 4    |
| (g) external projection (I09), the real R4 and the agent         | 4    |
| (h) pre-pickup agent restrictions and successes (I12)            | 35   |
| (i) after pickup — ceiling, out of purpose, narrowed (I07/I08)   | 44   |
| (j) agent decision excluded, with the person's success beside it | 2    |
| (k) real handback, and a delegation revoked through its route    | 9    |

(c) and (d) are asserted to be **indistinguishable** — same status, same code,
same body shape — which is the half of N1 that a foreign-read test usually
leaves out.

**Case (g) is the real external party now.** It used to record
`except('external-party', …, 'no non-member role in the seed')`. It now enrols
R4 with `enrolExternal`, shares the agent's task with `shareRecord`, and
observes three passing rows: the shared read (`sharedTask`, no internal note,
no title), a sibling `task.read` and a `task.board`, both `NOT_FOUND`. With the
share taken out, the read row fails `AUTH_NO_MEMBERSHIP` 403. The fourth row is
the agent's own read through `externalCommentProjection`.
`tests/acceptance/external-party.test.ts` is the full R4 suite.

### What each exception is

An exception is a row that records a reason instead of a verdict. **None is an
owner waiver**, and the word "exception" accepts nothing. Each row's reason
text starts with one of three labels:

- **Executed alternative**: something in this run asserts a different,
  specified outcome for it. The reason names what, and the table cites the
  spec line.
- **Not applicable**: the role does not fit the case, with the spec line that
  defines the case. The row names where the real rows for that operation are.
- **Missing coverage**: nothing in this run asserts it. The reason, or the
  table, names what would, and who owns it.

Four rows are executed alternatives:

| Rows                            | What is asserted instead                                                                      | Spec line                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- |
| (a) `grant.revoke`              | the admin's revocation succeeds, case (f)                                                     | contract ledger line 36, revocation controls |
| (a) `delegation.revoke`         | the admin revokes a live delegation, case (k); the agent's next call is `DELEGATION_NOT_LIVE` | contract ledger line 36, revocation controls |
| (i) `task.queue`, `task.pickup` | both succeed without a delegation, case (h)                                                   | contract ledger line 62, I12                 |

The four `session.capabilities` rows now pass with the contract's outcome.
(e) `noah`, a member holding nothing, is refused `SCOPE_NOT_GRANTED` (minimum
contract 8.2 case 3); (e) `mia`, who holds grants, is answered her own pairs as
the control. (h) before a pickup the agent login is refused
`DELEGATION_EXCLUDES_OPERATION` (case 9); (i) under the live delegation it is
answered with `purposeScope` the picked-up task.

Twenty-three rows are not applicable: (e) for `mia`, one on each pair she
holds. Case 3 is R2 against every endpoint (minimum contract line 493), and R2
is a member **without** that grant (line 481). `mia` holds `task:read`,
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

Case (k) drives the three operations the old rows only described:

- **Wrong-purpose lease.** The same agent picks up a second reservation, on
  the sibling and for another purpose. Under the first credential it hands
  back the sibling's lease at that lease's own fence. The answer is
  `DELEGATION_OUT_OF_PURPOSE` 403, because `subjectTaskId` reads the task from
  the lease (`agent-envelope.ts:428-446`). The sibling lease has no
  `handback_reports` row afterwards. This is the (i) `task.handback` row. The
  old text expected `LEASE_NOT_OWNED`, which is the answer for a stale fence
  on a lease in the same purpose.
- **Handback.** A person naming the sibling's lease is refused and settles
  nothing; no code is asserted, because person handback is PERSON-WORK's. The
  sibling's own credential then hands its lease back (200, the reservation
  named), and its next call is `DELEGATION_NOT_LIVE`.
- **Revocation.** A third pickup. `noah` is refused `delegation.revoke`,
  `SCOPE_NOT_GRANTED`. The admin revokes it through `delegation.revoke`
  (200), and the agent's next read is `DELEGATION_NOT_LIVE`.

Contract ledger lines are in the build run's
`t1a-revision/CONTRACT-LEDGER.md`. The minimum contract is
`research/minimum-contract-2026-09-10/CONTRACT.md` in the roadmap repository.
Neither is in this tree.

## Item 3: the protected set on three surfaces

Eleven fields, read by name from `PROTECTED_TASK_FIELDS`, submitted through the
API's person prefix, through `apps/cli/client.ts` and through the web client's
`submitEdit`. Thirty-three refusals, and **every one of them reads the record
back out of `public.records`** and asserts the stored value and the revision
did not move. A refusal that still wrote is the failure this proof exists to
catch, and a test that only read the response body could not catch it.

**The refusal is three codes, not one.** The test derives which from the
field's own `writeMode` rather than expecting a single answer:

| Fields                                                                                                                                          | Code                   | Status  |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------- |
| the eight operation-owned (`assignee`, `delegate`, `parent`, `client`, `client_visible`, `stage`, `state`, and `intake_state`'s classification) | `TRANSITION_PROTECTED` | 422     |
| `completed_at`, `key`                                                                                                                           | `FIELD_NOT_WRITABLE`   | 422     |
| `source`, `intake_state`                                                                                                                        | `SOURCE_SPOOFED`       | **403** |

`intake_state` appears twice on purpose: `refuseSpoof`
(`packages/core-records/src/commands/tasks-write.ts:41`) runs before the engine
classifies, so it never reaches its `TRANSITION_PROTECTED`. That matches
`tests/commands/task-fields.test.ts:103`. Every status is read through
`statusFor`, so the boundary is proved to use the register's own table rather
than a number it chose.

**The positive controls are beside them**, because a server that refused
everything would pass the refusal half: `task.assign` for `assignee`,
`task.set_stage` for `stage`, the `task.start` → `task.complete` →
`task.reopen` lifecycle for `state` — which carries D04's `completed_at` derive
and clear — and an ordinary `title`/`due`/`priority` edit.

`completed_at`, `key` and `source` are system-derived and have **no owning
operation**, so there is no positive control to put beside them. That is stated
in the file rather than papered over.

**The proof is falsifiable, and this was demonstrated rather than asserted.**
With the `assignee` case temporarily routed through `task.assign` — the
operation that really writes the field — the database readback failed 33 cases
with `+ "assignee": "cfaa5cb8-…"`, then passed 38 again on revert. The
refusal-writes-anyway failure this proof exists to catch is reachable.

## Item 5: the restart proof (W06), as one named run

```sh
pnpm verify:restart --evidence .local/restart-proof/<name>.txt
# defaults, declared in scripts/local/restart-proof.sh:
#   --name ops-astro-restart-proof-pg  --port 54398  --api-port 8798
```

`scripts/local/restart-proof.sh` creates a disposable Postgres from the pinned
digest, refuses before starting anything if the name or either port belongs to
the working slice, the datafix database or the Hub's `supabase_*` stack, or if
the name already exists or a port already answers, migrates it at the checked-out
head, and runs `restart-and-expiry.test.ts`, `restart-http.test.ts` and
`restart-declared.test.ts` with `--fileParallelism=false` and both restarts
asked. The evidence file carries the head sha, the migration output, `StartedAt`
before and after, every compared identity with its state, the API process ids
before and after, each HTTP answer, and the verbose test output. On success and
on failure the exit trap stops every API process the run wrote to its pid file,
records whether the API port is free, removes the container, and writes the
exit status as the last line. Pass is exit 0, `api port free`, `container
removed`, and `Tests 24 passed (24)`, with no expected failure.
The 24 is the count from the head the proof was last run on; it has not been
run at `cca3c89`. A lane with its own stack passes `--name`, `--port` and
`--api-port` rather than taking the defaults, which belong to the coordinator.

After the restart, `restart-http.test.ts` also asks for a third
`request_changes` on the same lineage and gets 409 `CHANGE_ROUNDS_EXHAUSTED`,
audited as a refusal (G08, `restart-http.test.ts:405-424`).

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

| W06 claim                              | Postgres restart                                                                                   | API process restart, over HTTP                                                                                                                                                                                              | browser B6 leg (lane stack, 1e1eef2)                |
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

A lapsed gate keeps the stored state `pending`: `migrations/0011_runtime_gates.sql:16`
says nothing expires a gate on a timer, and `decide.ts` refuses it on the
database clock (G06). Expiry is read, never written.

**Still open, by name.** (1) The browser leg carries a pending gate, a lease
and a dispatched attempt across a restart (B6, merged at 1e1eef2), proved on
the lane's own stack only. The run at the integrated candidate is with the
coordinator. It does not yet reload onto a proposal's lineage, a decision
chain or a cancelled lineage. Cancellation and authorised restart are closed
over HTTP: L3-CONTROLS declared `task.cancel` and `task.restart` (9bf4c69), both
cases run as plain `it`, and the cancelled-lineage fixture in
`walkTheOtherLineages` cancels through `task.cancel` on the API.

## Defects found in other lanes' files

Five defects were found here and recorded as cases that asserted the behaviour
as observed. Four are fixed on this head, and the cases now assert the fix.

1. **Fixed: an absent `operationId` was answered untyped.** `envelope.ts`
   guarded it with `OPERATION_ID.test(...)`, which coerced `undefined` to the
   string `"undefined"`, and the caller got a plain-text 500. The guard now
   checks the type first (`packages/core-records/src/commands/envelope.ts:90`),
   and `surface-inventory.test.ts:307` asserts `OPERATION_ID_REQUIRED` 422 for
   the absent field, `null` and `''`.
2. **Fixed: five declarations answered an untyped fault.** `task.create`,
   `task.restore`, `task.purge`, `task.read` and `preset.plan` gave an
   authorised admin a 500 for a bare envelope. They now answer typed operand
   refusals (API.md, "Routes"), and `surface-inventory.test.ts` requires
   **zero** person-prefix untyped faults over all 35 declarations.
3. **Fixed: the mounted app did not draw the re-login path.** The web client's
   `SESSION_ENDED` now holds `AUTH_UNKNOWN_LOGIN` and `AUTH_SESSION_EXPIRED`
   (`apps/web/src/operations/client.ts:317`), and
   `restart-and-expiry.test.ts:362` asserts the hook fires once, carrying the
   expired code.
4. **Fixed: an agent could reach `task.comment` by the surface and not by the
   server.** `serve` has a `task.comment` branch
   (`commands/agent-envelope.ts:522`). The matrix's case (i) asserts the saved
   comment on the agent's own task, and `AUDIENCE_NOT_PERMITTED` for a
   `client` comment.
5. **Open: the command line cannot report a fault.** `apps/cli/client.ts:91`
   still reads every answer with `await response.json()`, which throws on a
   body that is not JSON. No declared operation answers the bare envelope with
   a fault any more, so the five above no longer reach it, but any non-JSON
   answer still surfaces as `SyntaxError` rather than a status.

## Interface gaps

A gap is a proof that cannot be written without a change to a source file this
lane does not own.

- **Closed: no external reader could be minted (I09).** R4 is enrolled by
  `enrolExternal` and shared with by `shareRecord`, and the matrix's case (g)
  drives it (see item 2). The seed still enrols none.
- **The tenancy testing package cannot answer "is RLS on this table right now".**
  `prefix-harness.ts` exports per-prefix machinery and keeps `rolesOf` private,
  so item 4 reuses `tenancyConformance` from
  `packages/core-records/src/tenancy/conformance.ts` — the check the harness
  itself calls — and hand-writes one `pg_class` query. A small exported
  `rowSecurityOf(read, table)` would remove that last hand-written query.
- **Closed: no seeded role could `task.decide`.** When this lane ran, the
  seed gave the admin no `decide` action, so against the live stack every
  decision and so every pickup was unreachable. The seed now gives the admin
  `task:decide` (`scripts/local-seed.mjs:96`); a member still does not hold it.
- **The fixture's member and the seed's member differ.** The seed's `member`
  holds `['task:read', 'task:write', 'task:assign', 'person:read', 'settings:read']`;
  `world.ts`'s `MEMBER_ACTIONS` is `read`, `write`, `assign` and `comment` on
  `task` only. Not load-bearing for the matrix, which reads grants back out of
  the `grants` table rather than trusting the list, but `mia` is not quite the
  same person in the two places.
- **`lockTask` is not exported**, so the predicate-less variant of the record
  lookup has to be hand-written in the proof rather than taken from the module
  it is a proof about.
- **`SPOOFABLE` is not exported.** `packages/core-records/src/commands/tasks-write.ts:38`
  holds `['source', 'intake_state']` privately, so that pair is the one
  hand-kept fact in `protected-fields.test.ts`. Exporting it would close the
  last hand-copy in the item-3 proof.
- **The web client discards the HTTP status on a refusal.** `WireRefusal`
  (`apps/web/src/operations/client.ts`) carries `code`, `names` and `fixes`
  only, so the web surface can assert the code and the names but not the
  status. A 403 `SOURCE_SPOOFED` and a 422 `TRANSITION_PROTECTED` are
  indistinguishable by status to the mounted app.
- **`refuseGenericWrite` reads the legacy spelling.**
  `packages/core-records/src/records/fields.ts:227` reads the derived joined
  `owningOperation` rather than the `text[]` `owningOperations` that
  `docs/local/AUTHORITY.md` names as the model. Not a defect — both come from
  one array and cannot disagree — but it is a new reader taking the legacy
  form, and it is why `state`'s refusal names read
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

The real command line is proved separately and needs no port:
`tests/cli/cli-process.test.ts` (named, 11 tests) runs `apps/api/server.ts`
and `apps/cli/main.ts` as separate OS processes over HTTP (person journey
with revisions checked in the database, board and people reads,
`SCOPE_NOT_GRANTED`, another business, an unknown verb that sends nothing, the
agent queue, pickup, heartbeat and handback, a bare agent call refused
`DELEGATION_EXCLUDES_OPERATION`, login, and the package script). See
[CLI.md](CLI.md).

Both are implemented and ran green on the SURFACE-FINAL lane's stack, and 7 of
7 on the DOCS-2 lane's own stack at `cca3c89` (tested, lane run). Neither has a
merge-trial run with the port set.

**Run them one file at a time.** Each file spawns its own `apps/api/server.ts`
on the one port `SURFACE_API_PORT` names. Under Vitest's default file
parallelism the two servers start together, the second cannot bind
(`EADDRINUSE`), and its suite fails with "the API process did not answer" (U1
in `server-onerror.test.ts`). The coordinator's live run at `54700f7` showed
both results: 4 passed, 1 file failed together, 7 of 7 passed serially
(`parent-observations/runs/54700f7/surface-api-port.log` and
`surface-api-port-serial.log`). Run them like this, with the stack's
`DATABASE_URL` and `DATABASE_ADMIN_URL` set and any spare loopback port:

```sh
SURFACE_API_PORT=8812 pnpm exec vitest run --fileParallelism=false \
  tests/api/server-onerror.test.ts tests/cli/mounted-cli.test.ts
```

Two separate `vitest run` invocations, one file each, work equally well.

## D06 and D03 on the mounted browser (D06, D03, I02, I11)

`tests/browser/d06-mounted.mjs` (`pnpm verify:d06-mounted`, beside
`verify:browser` rather than inside it) runs the in-process D06 grid again in
a real Chromium page. The person signs in through GoTrue, and every request
is made by the `OperationsClient` module Vite serves to that page
(`throughClient`), against the API on a socket and a real Postgres. The grid
is not copied. The operations, keys, probe values and durable comparison come
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
  - `grant.revoke`: its grant is issued by `tests/commands/fixture.ts`
    `grantTo`, because no page operation issues a grant.
  - `delegation.revoke`: its delegation is opened by the alpha agent's pickup
    on `/api/a/b/alpha/task/pickup`, because an agent is not a page user.
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

**Lane runs on `20363eb`** (tested, lane run, own stack: Postgres on 54399,
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

## Engineering rulings, and how far each is proved

The build's root ruled on contract questions the lanes raised at `906613f`,
`01a437a` and after the item-5 triage. Each ruling is an engineering reading of
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
| The external party's task page draws only the server's shared projection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | R4                                                      | implemented; browser rows not run at `cca3c89`                                          |
| When a grant's loss revokes a delegation, the server records the cause (`authority_lost`), and the bound agent's next call on its unexpired credential is `DELEGATION_NARROWED`. Nothing is reactivated; explicit revocation, expiry and settlement keep `DELEGATION_NOT_LIVE`.                                                                                                                                                                                                                                                                                                   | minimum contract 8.2 case 6, ledger I08, T5             | tested (merge trial): `authority-loss-narrowed`, `runtime-residuals`                    |
| New decisions sign round, decision time, acting actor and their chain context in a versioned payload (v3). Older rows are verified for what they signed and never rewritten.                                                                                                                                                                                                                                                                                                                                                                                                      | T2                                                      | tested (merge trial): `decision-v3`                                                     |
| `task.purge` reads the caller's business's `retention_window_days` inside the serving transaction and purges trash older than that window by the database clock; a body `olderThanDays`, any value, is `COMMAND_BODY_INVALID` 400 with no mutation and one refused audit row. No default, floor or ceiling is applied. Source interpretation, recorded as root ruling 2's: consuming the stored setting completes the L3 retention contract for this retained operation. It is not a claim that Nathan moved Q46 forward, and it does not discharge the other G5 completion rows. | SPEC 14.3, SPEC:319, C12-5 Q46, ledger L3 retention row | tested (lane `L3-RETENTION`, not yet a merge trial): `purge-retention`                  |
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

## What is not here

Named by item number so the unfinished frontier stays countable.

- **No exported share operation.** R4's share is issued by `shareRecord` from
  the tests; no route calls it ([API.md, "Open items"](API.md#open-items)).
- **The one statement outside a transaction.** The runtime connection's only
  statement outside a transaction is the `postgres` driver's per-connection
  `pg_type` array lookup (`fetch_types`), which `statement-capture-full.test.ts`
  asserts exactly. Turning `fetch_types` off in `tenancy/database.ts` would
  remove it. That is a product decision nobody has made yet.
- **The heartbeat's bounds are unconfirmed.** `schedules-heartbeat.test.ts` now
  tests the 8-hour lifetime total at the boundary and just past it. The bounds
  themselves, like the agent's internal-only comment audience, are lane choices
  that still need root or owner confirmation ([RUNTIME.md](RUNTIME.md#the-work-controls)).
- **Reports are stored**: `public.handback_reports`
  (`migrations/0018_runtime_handback_reports.sql:24`). Which report identities
  the restart proof compares is the restart section's to say, above.
