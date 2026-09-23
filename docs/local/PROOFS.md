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
pnpm exec vitest run tests/acceptance
```

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

## Item 1: the inventory

The enumeration is **generated from `COMMAND_SURFACE` itself**. There is no
list of operation names anywhere in the file, which is SPEC section 8's first
property: an endpoint added without a case fails the build, and a hand-kept
list would have put the drift in the place least likely to be read.

Measured on the run recorded at `eefd624`:

| Count                                                 | Measured                    |
| ----------------------------------------------------- | --------------------------- |
| Declarations                                          | **28** — 23 writes, 5 reads |
| Reachable on the person prefix `/api/b/:businessKey`  | **28 of 28**                |
| Reachable on the agent prefix `/api/a/b/:businessKey` | **28 of 28**                |
| Reachable through `apps/cli/client.ts`                | **28 of 28**                |
| Reachable through the web client's `read()` verb      | **3 of 5 declared reads**   |
| Declared and not landed                               | **none**                    |

Reachable means **routed, not permitted**: the request arrives at the operation
that owns the rule. Whether the operation then says yes or no is authority, and
authority is item 2's. Collapsing the two would let a route that refuses
everyone count as proof that the surface is served.

### Named exceptions

- **`task.queue` and `preset.plan` are reads the mounted app cannot reach as
  reads.** `OperationsClient.read()` takes `ReadName`, which is three names;
  the surface declares five. The other two are reachable only through
  `mutate()`, which always sends an `operationId` — and a read carries no
  operation identity, because it has nothing to replay. They are reached by the
  wrong verb rather than not at all. Closing this is a change to
  `apps/web/src/operations/client.ts`, which is not this lane's file.

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

4. **The command line cannot report a fault at all.**
   `apps/cli/client.ts:88` reads every answer with `await response.json()`,
   which throws on a body that is not JSON. Against the five above it raises
   `SyntaxError` rather than returning the status, so an operator driving the
   product through the command line sees a crash where the API sent a 500.

## Interface gaps

A gap is a proof that cannot be written without a change to a source file this
lane does not own.

- **No external reader can be minted through the seed's shape (I09).**
  `docs/local/AUTHORITY.md` records that comments are stored and the external
  projection function exists with no endpoint serving it: "Comments are stored
  and not yet projected through the API. The read that serves them is L3's."
  Until a read serves the projection, the external-comment case can only assert
  that the gap is there.
- **The tenancy testing package cannot answer "is RLS on this table right now".**
  `prefix-harness.ts` exports per-prefix machinery and keeps `rolesOf` private,
  so item 4 reuses `tenancyConformance` from
  `packages/core-records/src/tenancy/conformance.ts` — the check the harness
  itself calls — and hand-writes one `pg_class` query. A small exported
  `rowSecurityOf(read, table)` would remove that last hand-written query.
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
- **`DELEGATION_EXCLUDES_OPERATION` is not in `AUTHORITY.md`'s table.** The
  agent prefix answers it with 403 for most declarations, and the refusal-code
  table in `docs/local/AUTHORITY.md` names `DELEGATION_EXCLUDES_DECISION`,
  `DELEGATION_OUT_OF_PURPOSE`, `DELEGATION_NARROWED`, `DELEGATION_NOT_LIVE` and
  `DELEGATION_WIDENS` and not this one. The code and the document disagree
  about the surface an agent meets.

## What is not here

Named by item number so the unfinished frontier stays countable.

- **No external reader, so I09's projection case records a gap rather than a
  result.** See the interface gaps above.
- **No reports table**, so no report identity is compared across the restart.
