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
actor written the way the seed writes one. The seed itself is not imported: it
needs GoTrue and it writes into the running slice's database.

## The proof files

| File                        | Covers                                                    | State                |
| --------------------------- | --------------------------------------------------------- | -------------------- |
| `world.ts`                  | the shared fixture; not a proof                           | —                    |
| `surface-inventory.test.ts` | item 1, the exported-surface inventory (I02–I06)          | green, 10 cases      |
| `role-case-matrix.test.ts`  | item 2, the six roles and nine cases (SPEC 8, T1h, N1–N7) | see the matrix below |
| `protected-fields.test.ts`  | item 3, the protected set on three surfaces (D02–D04)     | green, 38 cases      |
| `predicate-rls.test.ts`     | item 4, the four-state predicate/RLS mutation proof (I14) | see below            |

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

Last measured on `local/working-slice` at `3c0e02a`, merged into this branch:

| Count                                                 | Measured                    |
| ----------------------------------------------------- | --------------------------- |
| Declarations                                          | **30** — 23 writes, 7 reads |
| Reachable on the person prefix `/api/b/:businessKey`  | **30 of 30**                |
| Reachable on the agent prefix `/api/a/b/:businessKey` | **30 of 30**                |
| Reachable through `apps/cli/client.ts`                | **30 of 30**                |
| Reachable through the web client's `read()` verb      | **3 of 7 declared reads**   |
| Declared and not landed                               | **none**                    |

Reachable means **routed, not permitted**: the request arrives at the operation
that owns the rule. Whether the operation then says yes or no is authority, and
authority is item 2's. Collapsing the two would let a route that refuses
everyone count as proof that the surface is served.

### Named exceptions

- **Four reads the mounted app cannot reach as reads.** `OperationsClient.read()`
  takes `ReadName`, which is three names; the surface declares seven.
  `task.queue` and `preset.plan` are reachable only through `mutate()`, which
  always sends an `operationId` — and a read carries no operation identity,
  because it has nothing to replay. `settings.read` and `session.capabilities`
  arrived with L3-PART-B-2 and `ReadName` did not widen with them, so the
  settings screen reaches both by **casting the name**
  (`apps/web/src/screens/settings/reads.ts:23,26`), which routes because the
  path is built from the string and type-checks only because the cast silences
  the union. All four are reached by the wrong verb rather than not at all. The
  case names exactly these four, so **it fails on the day `ReadName` widens**
  and the list is brought back down. Closing it is a change to
  `apps/web/src/operations/client.ts`, which is not this lane's file.

## Item 2: the six roles and the nine cases

`role-case-matrix.test.ts` with `role-case-harness.ts`, `role-case-bodies.ts`
and `role-case-ledger.ts`. The enumeration is generated from `COMMAND_SURFACE`
and the whole matrix is written to `.local/l5-matrix.tsv` as
`role · case · operation · observed code · observed status · expected · verdict`.

**283 rows: 253 pass, 30 named exceptions, zero failures**, as
`.local/l5-matrix.tsv` records them. The four exceptions added over the base are
the two new reads: `settings.read` joins case (a)'s positive control, and
`session.capabilities` is an exception in three places because it is the one
declaration that **needs no grant beyond membership**
(`reads/capabilities.ts:20`) — `noah` under (e), and the agent before and after
a pickup under (h) and (i). Each is asserted rather than skipped; the reasons
are below.

| Case                                                             | Rows |
| ---------------------------------------------------------------- | ---- |
| (a) own-business permitted — the positive control                | 30   |
| (b) foreign business in the path                                 | 30   |
| (c) foreign record id                                            | 16   |
| (d) fabricated id                                                | 16   |
| (e) no grant                                                     | 120  |
| (f) grant revoked since the last read (I10)                      | 2    |
| (g) external comment projection (I09)                            | 2    |
| (h) pre-pickup agent restrictions and successes (I12)            | 30   |
| (i) after pickup — ceiling, out of purpose, narrowed (I07/I08)   | 35   |
| (j) agent decision excluded, with the person's success beside it | 2    |

(c) and (d) are asserted to be **indistinguishable** — same status, same code,
same body shape — which is the half of N1 that a foreign-read test usually
leaves out.

Every exception carries its reason in the row rather than being dropped: the
two `task.pickup`/`task.handback` rows under (a) record that the person path
refuses them by design, and the `mia` rows under (e) record that she holds the
grant in question and the real no-grant role is `noah`.

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

## Defects found in other lanes' files

Both are recorded as cases that assert the behaviour **as observed**, so each
fails on the day it is fixed and this section has to be read. Neither is
repaired here.

1. **An absent `operationId` is answered untyped.**
   `packages/core-records/src/commands/envelope.ts:83` guards the attempt
   identity with `OPERATION_ID.test(request.operationId)`, and
   `RegExp.prototype.test` coerces its argument to a string. A request that
   omits the field arrives as `undefined`, coerces to the nine-character string
   `"undefined"`, and passes the pattern at
   `packages/core-records/src/commands/register-store.ts:35`
   (`/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u`). The real `undefined` then reaches
   `lookupAttempt`'s bound parameter and the driver raises `UNDEFINED_VALUE`, so
   the caller is handed a plain-text 500 instead of the `OPERATION_ID_REQUIRED`
   422 `apps/api/status.ts:83` promises. `null` and `''` are refused correctly:
   it is the absent field, which is what an ordinary HTTP caller sends most
   easily, that gets through.

2. **Five declarations answer an untyped fault where a typed refusal is owed.**
   With a well-formed envelope and no operation-specific fields, an authorised
   administrator receives a 500 from `task.create`, `task.restore`,
   `task.purge`, `task.read` and `preset.plan`. `task.decide` answers
   `FIELD_VALUE_INVALID` 422 for exactly this, so the pattern is in the tree
   and these five do not reach it. It matters beyond tidiness: the mounted
   app's client draws a non-2xx with no refusal body as _unavailable_
   (`apps/web/src/operations/client.ts`), which is the word for a server that
   fell over rather than one that decided, and checklist case B7 requires that
   distinction to be real.

3. **The mounted app does not draw the re-login path for an expired session.**
   `apps/api/app.ts` answers an expired bearer `AUTH_SESSION_EXPIRED` 401 on
   both prefixes, and `docs/local/AUTHORITY.md` calls that "the re-login path" —
   the one refusal that is a door the person can open. The web client has a hook
   for exactly that, `onSessionEnded`, and it fires on `SESSION_ENDED`, which
   `apps/web/src/operations/client.ts` defines as `AUTH_UNKNOWN_LOGIN`. Two
   different codes, so the hook does not fire for the one case it exists for.
   Driven through the real `OperationsClient` against the real app: the refusal
   arrives as `AUTH_SESSION_EXPIRED` and the hook fires **0 times**.

4. **An agent may reach `task.comment` by the surface and not by the server.**
   `packages/core-records/src/commands/agent-envelope.ts:98` puts `task.comment`
   in `AGENT_SURFACE`, and `task.pickup` mints `['read', 'comment', 'write']`,
   so a live credential passes `checkDelegatedAuthority` for it. But `serve`'s
   switch (`:320`–`:366`) has no `task.comment` branch, so the call falls to
   `default:` and answers `DELEGATION_EXCLUDES_OPERATION` 403 — **on the agent's
   own picked-up task**. The surface says it may; the server says it may not.

5. **The command line cannot report a fault at all.**
   `apps/cli/client.ts:88` reads every answer with `await response.json()`,
   which throws on a body that is not JSON. Against the five above it raises
   `SyntaxError` rather than returning the status, so an operator driving the
   product through the command line sees a crash where the API sent a 500.

## Interface gaps

A gap is a proof that cannot be written without a change to a source file this
lane does not own.

- **No external reader can be minted through the seed's shape (I09).** The
  read is there: `task.read` serves `externalCommentProjection` to every reader
  who is not internal (`packages/core-records/src/reads/tasks.ts:194`). What
  is missing is a reader. No seeded role is outside `owner`, `admin` and
  `member`, so the external-comment case can only assert that the gap is
  there.
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

- **No external reader, so I09's projection case records a gap rather than a
  result.** See the interface gaps above.
- **No reports table**, so no report identity is compared across the restart.
