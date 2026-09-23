<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The assembled proofs, as lane L5 built them

`tests/acceptance/` is one directory with one job: take the mechanisms the
other lanes built and ask, through the surfaces a caller actually has, whether
they hold. Nothing in it is a plan and nothing in it is a count of
declarations. Where a proof could not be written, this file says so by name.

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
actor written the way the seed writes one. The external party (R4) is not in
the seed: `enrolExternal` in `world.ts` makes one, a person of `alpha` with a
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
| `external-party.test.ts`    | R4 over HTTP: the shared read and nothing else (I01, I09) | green                |

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

**331 rows: 296 pass, 35 named exceptions, zero failures**, as
`.local/l5-matrix.tsv` recorded them on this branch. The rows grew with the
five support controls, which every generated case now reaches.

| Case                                                             | Rows |
| ---------------------------------------------------------------- | ---- |
| (a) own-business permitted — the positive control                | 35   |
| (b) foreign business in the path                                 | 35   |
| (c) foreign record id                                            | 16   |
| (d) fabricated id                                                | 16   |
| (e) no grant                                                     | 140  |
| (f) grant revoked since the last read (I10)                      | 4    |
| (g) external projection (I09), the real R4 and the agent         | 4    |
| (h) pre-pickup agent restrictions and successes (I12)            | 35   |
| (i) after pickup — ceiling, out of purpose, narrowed (I07/I08)   | 44   |
| (j) agent decision excluded, with the person's success beside it | 2    |

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
text starts with one of two labels:

- **Executed alternative**: something in this run asserts a different,
  specified outcome for it. The reason names what, and the table cites the
  spec line.
- **Missing coverage**: nothing in this run asserts it. The reason, or the
  table, names what would.

Nine rows are executed alternatives:

| Rows                                            | What is asserted instead                                         | Spec line                                                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) `grant.revoke`                              | the admin's revocation succeeds, case (f)                        | contract ledger line 36, revocation controls                                                                                                              |
| (a) `task.pickup`                               | the agent's pickup succeeds, case (h); the person path refuses   | contract ledger line 30; minimum contract 8.2 case 9                                                                                                      |
| (a) `task.heartbeat`                            | the agent's own-lease beat succeeds, case (i)                    | contract ledger line 38                                                                                                                                   |
| (i) `task.queue`, `task.pickup`                 | both succeed without a delegation, case (h)                      | contract ledger line 62, I12                                                                                                                              |
| (i) `session.capabilities`                      | 200, `purposeScope` is the picked-up task                        | none in the contract, which has no read of this kind; the rule is API.md, "Reads", and needs the root's ruling                                            |
| (h) `session.capabilities`                      | 200, `purposeScope` null, grants exactly `BEFORE_PICKUP`'s pairs | none: minimum contract 8.2 case 9 says every other operation is refused. The alternative is `agent-envelope.ts:98-107`'s rule and needs the root's ruling |
| (e) `session.capabilities` for `noah` and `mia` | 200 with the caller's own grants                                 | none: minimum contract 8.2 case 3 says `SCOPE_NOT_GRANTED`. The alternative is `reads/capabilities.ts:20`'s rule and needs the root's ruling              |

Twenty-six rows are missing coverage:

| Rows                                        | What would cover it                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| (e) 23 `mia` rows, each on a pair she holds | a member-positive sweep over each caller's held pairs. Case (a) drives the admin only. Case (f) happens to assert her `task.read` success |
| (a) `task.handback`                         | a handback at the end of the agent journey. `tests/api/task-runtime-routes.test.ts:417` holds its success outside the matrix              |
| (a) `delegation.revoke`                     | revoking the journey's own delegation after case (i). `tests/api/controls-revoke.test.ts:107` holds it outside the matrix                 |
| (i) `task.handback`                         | a handback naming a lease another delegation holds, expecting `LEASE_NOT_OWNED`                                                           |

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
removed`, and `Tests 22 passed | 2 expected fail (24)`.

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

| W06 claim                              | Postgres restart                                                                                     | API process restart, over HTTP                                                                                                                        | browser B6 leg |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| task identity                          | row read back through a fresh `createApi`                                                            | `task.read`, same id                                                                                                                                  | yes (task)     |
| lineage, version, evidence pack        | ids and lineage state compared                                                                       | same in the `proposals` projection                                                                                                                    | no             |
| gate and gate state                    | `id:state` compared                                                                                  | same in the projection                                                                                                                                | no             |
| gate decision chain                    | ids compared                                                                                         | ids, signatures and hashes compared                                                                                                                   | no             |
| reservation, lease, attempt            | `id:state` compared                                                                                  | same in the projection                                                                                                                                | no             |
| delegation                             | `id:live/settled/revoked` compared                                                                   | DB rows compared around the HTTP calls                                                                                                                | no             |
| receipt (handback report)              | a report minted before the restart, id compared                                                      | receipts go from 1 to 2 on one HTTP handback                                                                                                          | no             |
| operation register                     | operation ids compared                                                                               | DB rows compared                                                                                                                                      | no             |
| no auto approval                       | the undecided gate stays `pending` with 0 decisions                                                  | a gate that lapsed while down answers 410 `GATE_EXPIRED`; 0 decisions, 0 holds, stored state `pending`                                                | no             |
| no silent cancelled-lineage resumption | **open**: the lineage is cancelled by the `cancelAndClassify` fixture, which is not an accepted path | **open**: pickup answers 409 `RESERVATION_NOT_CLAIMABLE`, no lease, but on the same fixture; `task.cancel` and `task.restart` answer 404 (`it.fails`) | no             |
| no duplicated proposal or hold         | byte-identical propose and decide replays add no row                                                 | the same replays over HTTP add no row                                                                                                                 | no             |
| handback exactly once                  | second handback 401 `DELEGATION_NOT_LIVE`, replayed pickup mints no lease                            | the same over HTTP                                                                                                                                    | no             |
| Request Changes across a restart       | not exercised                                                                                        | version 1 sent back before, version 2 proposed after; a replay leaves versions `1,2`                                                                  | no             |

A lapsed gate keeps the stored state `pending`: `migrations/0011_runtime_gates.sql:16`
says nothing expires a gate on a timer, and `decide.ts` refuses it on the
database clock (G06). Expiry is read, never written.

**Still open, by name.** (1) The browser does not reload across a restart onto
the proposal, gate, lease or attempt: the B6 leg covers the task only.
(2) Run cancellation and authorised restart are required through owning
production interfaces (contract ledger lines 37-38 and the paragraph after the
table), and neither has a route at this head. `restart-http.test.ts` holds
`task.cancel` and `task.restart` as `it.fails` cases, which answer 404 today.
Until the routes land, the cancelled-lineage row stays open and its fixture
stays `cancelAndClassify`. L3-CONTROLS owns the routes.

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
   (`commands/agent-envelope.ts:460`). The matrix's case (i) asserts the saved
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

## What is not here

Named by item number so the unfinished frontier stays countable.

- **No exported share operation.** R4's share is issued by `shareRecord` from
  the tests; no route calls it ([API.md, "Open items"](API.md#open-items)).
- **Twenty-six matrix rows are missing coverage**, named with what would cover
  them under item 2. Four more, the `session.capabilities` rows, are executed
  alternatives with no contract line behind them and need the root's ruling.
- **The heartbeat's 8-hour lifetime cap is untested**, and its bounds, like the
  agent's internal-only comment audience, are lane choices awaiting root or
  owner confirmation ([RUNTIME.md](RUNTIME.md#the-work-controls)).
- **Reports are stored**: `public.handback_reports`
  (`migrations/0018_runtime_handback_reports.sql:24`). Which report identities
  the restart proof compares is the restart section's to say, above.
