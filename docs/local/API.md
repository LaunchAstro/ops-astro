<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The working slice's API

The HTTP boundary for the local working slice: what it exposes, how a caller
is identified, and how to start and check it.

## Starting it

```sh
export PATH="$TOOLCHAIN/node-v24.21.0-darwin-arm64/bin:$PATH"
scripts/local/db-up.sh        # SLICE-DATA: Postgres on 127.0.0.1:54390
scripts/local/auth-up.sh      # GoTrue on 127.0.0.1:54391, writes .local/auth.env
node scripts/db-migrate.mjs   # SLICE-DATA: migrations
node scripts/local/auth-seed.mjs   # the five synthetic logins
node scripts/local-seed.mjs        # SLICE-DATA: businesses, persons, logins, grants
scripts/local/api-up.sh       # the API on 127.0.0.1:8790
node scripts/local/verify-slice.mjs
```

`auth-up.sh` starts Postgres itself if it is not already up, with the same
container name, pinned digest, port and volume `db-up.sh` uses, so the two
converge whichever runs first. Neither script touches the Hub's `supabase_*`
containers.

`.local/` holds `db.env`, `auth.env` and `synthetic-users.json`. It is
gitignored and never enters a commit.

## Routes

Every route is `POST /api/b/:businessKey` + the command's path, and every path
is derived from `COMMAND_SURFACE`: `task.create` is `/api/b/alpha/task/create`.
Nothing is written out by hand, so an operation another part declares becomes
reachable with no edit to the API, and a command with no declaration has no
route to be reached through.

`GET /api/health` is the one exception. It runs a statement and answers from
the result: `200` with `database: "reachable"`, or `503` with
`database: "unreachable"` and the reason. It also reports whether the read half
of the surface is mounted.

| Body               | Meaning                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `operationId`      | Required on every mutation. The repeat-request identity.           |
| `expectedRevision` | Required on a command with an existing record to be stale against. |
| `fields`           | The values the command owns. Reads take neither of the two above.  |

A success is the envelope's outcome — `recordId`, `revision`, `detail`. A
refusal is `{ code, names, fixes }` under the status `apps/api/status.ts` maps
the code to. The code is what a client branches on; the status is what a proxy
and a log reader see, and neither is derived from the other.

## Who is calling

`Authorization: Bearer <GoTrue access token>`. The adapter verifies the HS256
signature and `exp` with `SUPABASE_JWT_SECRET` and takes `sub` as
`VerifiedSubject { provider: 'supabase', subject }`.

Nothing else reaches identity. Not a body field, not a host or forwarded
header, not an `apikey`, not a query parameter. A request carrying `actorId` or
`businessId` alongside its token is a request with those fields nowhere to go.
A missing, expired, forged, unsigned or subject-less token all answer
`AUTH_UNKNOWN_LOGIN`, because telling them apart tells an unauthenticated
caller which guess was closer.

The business is named by the path and verified by login resolution. A business
the caller is not a member of and a business that does not exist both answer
`AUTH_NO_MEMBERSHIP`, for the same reason an unmapped subject and a missing
login refuse identically: the difference is an inference across a tenancy
boundary.

The algorithm is named when verifying rather than read from the token's own
header, so a token nominating `alg: none` verifies against no key at all.

## What the boundary is not

It holds no authority check. Every refusal in a response came back from the
operation, inside the serving transaction, through the grant path. There is no
check here to remove, because there is none here.

It reads no record. The only statement it causes outside `withBusiness` is the
business-key lookup in `server.ts`, which reads one column of one row: the
tenancy root sits behind forced row security keyed on a setting the serving
transaction has not set yet, so that one mapping has to precede tenancy. Every
statement after it runs through the wrapper.

## Reads

`task.read`, `task.board` and `person.list` are SLICE-DATA's, declared in
`COMMAND_SURFACE` with `kind: 'read'`. The boundary branches on that and calls
the executor the composition root supplies:

```ts
executeRead(database, businessId, presented, request) => Promise<unknown>
```

exported as `executeRead` from `packages/core-records/src/reads/execute.ts`,
returning either the contract's `{ ok: true, ... }` shape or a command refusal.
A declared read with no executor refuses `DEPENDENCY_NOT_LANDED` rather than
`404`, which is the answer the surface already gives for a part not yet built.

## Verifying it

`node scripts/local/verify-slice.mjs` signs in through the local GoTrue with
the seeded passwords and walks create, start, complete, reopen and edit, then
the refusals: a foreign business writing a real and a fabricated id with their
bodies and timings compared, a login with no membership, a replayed operation
identity, a reused one, a stale revision, generic writes to protected fields, a
spoofed system field, and a body and headers carrying an actor and a business
that reach nothing. One line per case with the status and the code it observed;
a case that cannot run yet prints `unrun` with its reason.
