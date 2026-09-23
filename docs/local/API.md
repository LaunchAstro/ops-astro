<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The working slice's API

The HTTP boundary for the local working slice: what it exposes, how a caller
is identified, and how to start and check it.

## Starting it

Run everything from the repository root, with the pinned Node on the path. The
toolchain lives outside the repository; `TOOLCHAIN` below is wherever the run's
`ops-astro-implement-readiness-2026-09-22/toolchain` directory is on this
machine.

```sh
export PATH="$TOOLCHAIN/node-v24.21.0-darwin-arm64/bin:$PATH"
bash scripts/local/db-up.sh   # SLICE-DATA: Postgres on 127.0.0.1:54390
bash scripts/local/auth-up.sh # GoTrue on 127.0.0.1:54391, writes .local/auth.env
node scripts/db-migrate.mjs   # SLICE-DATA: migrations
node scripts/local/auth-seed.mjs   # the five synthetic logins
node scripts/local-seed.mjs        # SLICE-DATA: businesses, persons, logins, grants
bash scripts/local/api-up.sh  # the API on 127.0.0.1:8790
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

## The operations L2 made possible

Four rows joined the surface when L2's model modules landed, and one came off
the pending list. Each reaches the API and the command line by generation, so
there is no route written out for any of them.

| Operation                          | Route                               | Body                                                                              | Refusals it can answer                                                                                                                                     |
| ---------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.comment`                     | `/task/comment`                     | `operationId`, `recordId`, `expectedRevision`, `body`, `audience`, `commentType?` | `SCOPE_NOT_GRANTED` 403, `FIELD_VALUE_INVALID` 422, `NOT_FOUND` 404, `VERSION_STALE` 409, `DEPENDENCY_NOT_LANDED` 501 where a business has no comment type |
| `preset.plan`                      | `/preset/plan`                      | `recordTypeKey`, `presetKey`, `fields[]`                                          | `SCOPE_NOT_GRANTED` 403, `PRESET_FIELD_UNCLASSIFIED` 422, `PRESET_TYPE_UNKNOWN` 404, `PRESET_FIELD_UNPLACEABLE` 409                                        |
| `settings.set_four_eyes_threshold` | `/settings/set_four_eyes_threshold` | `operationId`, `value` (number or `null`)                                         | `SCOPE_NOT_GRANTED` 403, `FIELD_VALUE_INVALID` 422, `NOT_FOUND` 404                                                                                        |
| `settings.set_client_sign_off`     | `/settings/set_client_sign_off`     | `operationId`, `value` (boolean)                                                  | `SCOPE_NOT_GRANTED` 403, `FIELD_VALUE_INVALID` 422, `NOT_FOUND` 404                                                                                        |

`task.comment` writes a comment record beside the task and leaves the task's
own revision alone, so a caller may keep writing against the revision they
hold. The author is the acting actor and the posting time is the server's;
neither is a payload field.

`preset.plan` is declared `kind: 'read'` because it writes nothing at all,
including on success. It is the one read that does not take the `read` action:
it asks for `manage` on presets, which is why the collection and the action
are on the declaration rather than assumed from the kind.

The two settings commands take no `expectedRevision`: `business_settings`
carries no revision column, so there is nothing for a caller to write against.
That is a schema gap rather than a decision and it is recorded as one.

**Five routes are unchanged and still refuse.** `task.propose`, `task.decide`,
`task.pickup`, `task.handback` and the agent's own API path answer
`DEPENDENCY_NOT_LANDED` 501 naming what they wait for. They wait on L4's
runtime mechanisms and are part B of L3; nothing here is a placeholder for
them.

## Reads

`task.read`, `task.board`, `person.list` and `preset.plan` are declared in
`COMMAND_SURFACE` with `kind: 'read'`. The boundary branches on that and calls
the executor the composition root supplies:

```ts
executeRead(database, businessId, presented, request) => Promise<unknown>
```

exported as `executeRead` from `packages/core-records/src/reads/execute.ts`,
returning either the contract's `{ ok: true, ... }` shape or a command refusal.
A declared read with no executor refuses `DEPENDENCY_NOT_LANDED` rather than
`404`, which is the answer the surface already gives for a part not yet built.

`task.read` carries the task's comments. An internal reader — a membership
role of `owner`, `admin` or `member` — is given every comment in full; every
other role is given `externalCommentProjection`'s answer, which is the client
comments in the fields the catalogue marks `shared` (`id`, `audience`,
`author`, `body`, `comment_type`, `posted_at`). External is the default, so a
role nobody classified sees the client view rather than everything.

**Every read writes an audit event**, of the same shape the commands write,
successful and refused alike (I13). Its `operation_id` is null: a read has
nothing to replay. A read of one task carries that task as the subject, which
is what makes "who looked at this" answerable — and the task's own `history`
excludes the reads, because a history is what happened _to_ the task.

## Verifying it

`node scripts/local/verify-slice.mjs` signs in through the local GoTrue with
the seeded passwords and walks create, start, complete, reopen and edit, then
the refusals: a foreign business writing a real and a fabricated id with their
bodies and timings compared, a login with no membership, a replayed operation
identity, a reused one, a stale revision, generic writes to protected fields, a
spoofed system field, and a body and headers carrying an actor and a business
that reach nothing. One line per case with the status and the code it observed;
a case that cannot run yet prints `unrun` with its reason.
