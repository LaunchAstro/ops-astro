<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The command line

`apps/cli/main.ts` is the ordinary command line for the local working slice.
It is a client of the same authenticated API the browser uses: each call posts
one operation over HTTP and prints what the API answered. It has no other path
to the data.

## Running it

Nothing to install beyond the repository's own dependencies. From the
repository root, with the pinned Node on the path and the API running
([API.md](API.md) says where `TOOLCHAIN` points):

```sh
export PATH="$TOOLCHAIN/node-v24.21.0-darwin-arm64/bin:$PATH"
pnpm cli --help                       # the operations, from the command registry
pnpm cli login --email ada@alpha.local   # password on stdin, or OPS_ASTRO_PASSWORD
pnpm cli task.board --business alpha --json '{"board":null}'
pnpm cli task.create --business alpha --json '{"fields":{"title":"Call the supplier"}}'
pnpm cli task.read --business alpha --body-file ./read.json
pnpm cli logout
```

`node apps/cli/main.ts` runs the same entry without pnpm. `pnpm cli` prints
nothing of its own on stdout, so the output can be piped to `jq`.

The operation list comes from `COMMAND_SURFACE`
(`packages/core-records/src/commands/surface.ts`), the same registry the API
mounts its routes from. An operation the API has not landed is listed with what
it is waiting on. The command line answers an operation it does not know on its
own, before it reads the body, business, bearer or API origin and before it
sends any request. It prints
`{"code":"COMMAND_UNKNOWN","names":[<verb>],"fixes":[...]}` and exits 2
(`unknownVerb`, `apps/cli/client.ts`).

## Flags and environment

| Flag                 | Environment                 | Meaning                                                                                   |
| -------------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| `--json <object>`    |                             | The operation's body as a JSON object. Default `{}`.                                      |
| `--body-file <path>` |                             | The body read from a file. Use one of `--json` and `--body-file`, not both.               |
| `--business <key>`   | `OPS_ASTRO_BUSINESS`        | The business key in the path. The server decides whether the login belongs to it.         |
| `--api <url>`        | `OPS_ASTRO_API_URL`         | The API origin. Default `http://127.0.0.1:8790`.                                          |
|                      | `OPS_ASTRO_TOKEN`           | The bearer. When unset, the file `login` wrote is used.                                   |
|                      | `OPS_ASTRO_TOKEN_FILE`      | Where `login` saves the bearer. Default `.local/cli-token` (owner-only, ignored by Git).  |
| `--email <address>`  | `OPS_ASTRO_EMAIL`           | `login` only.                                                                             |
|                      | `OPS_ASTRO_PASSWORD`        | `login` only. When unset, the first line of stdin.                                        |
| `--gotrue <url>`     | `OPS_ASTRO_GOTRUE_URL`      | `login` only. Default `http://127.0.0.1:54391`.                                           |
| `--agent`            | `OPS_ASTRO_AGENT=1`         | Call the agent prefix instead of the person prefix.                                       |
|                      | `OPS_ASTRO_DELEGATION`      | Agent mode: the delegation credential. When unset, the file a pickup wrote is used.       |
|                      | `OPS_ASTRO_DELEGATION_FILE` | Where an agent pickup saves its credential. Default `.local/cli-delegation` (owner-only). |

The bearer and the delegation credential are never taken as flags, so they do
not appear in a process listing or shell history, and the command line never
prints either of them.

A write needs an `operationId`; when the body has none, the command line adds a
fresh one. A read on the person prefix is sent with exactly the body given and
no `operationId`. Every call on the agent prefix (`--agent`) gets one, reads
included, because the agent envelope refuses any call without it
(`OPERATION_ID_REQUIRED` in `runAgentCommand`,
`packages/core-records/src/commands/agent-envelope.ts`). To retry a write
safely, put your own `operationId` in the body and send the same body again.
The API replays the first answer instead of writing twice.

## Person and agent use

**Person.** `login` does the same GoTrue password grant the web sign-in does
(`apps/web/src/session/sign-in.ts`, imported rather than copied) and saves the
access token. Calls go to `/api/b/<business>/...` with that bearer.

**Agent.** An agent signs in with its own login, never a person's. The seed's
agent logins are GoTrue passwords like a person's (`scripts/local-seed.mjs`,
recorded in `.local/synthetic-agents.json`), so `login` works for them too. The
agent then passes `--agent` or sets `OPS_ASTRO_AGENT=1`, and calls go to
`/api/a/b/<business>/...`. Before a pickup an agent can call `task.queue` and
`task.pickup`; the API refuses `task.decide` with
`DELEGATION_EXCLUDES_DECISION` and anything else with
`DELEGATION_EXCLUDES_OPERATION`. A successful `task.pickup` saves the
delegation credential to the delegation file and prints the answer with that
credential replaced by `(saved to <file>)`. Later calls
(`task.heartbeat`, `task.read`, `task.comment`, `task.handback`) send it in the
`x-agent-delegation` header. A successful `task.handback` removes the file when
it holds the credential that handback was sent with. A handback sent with
another credential through `OPS_ASTRO_DELEGATION`, such as a replay of an older
lease, leaves the saved one alone (`tests/cli/cli-delegation-replay.test.ts`).

```sh
export OPS_ASTRO_AGENT=1 OPS_ASTRO_BUSINESS=alpha
pnpm cli task.queue
pnpm cli task.pickup --json '{"reservationId":"<reservationId>"}'
pnpm cli task.heartbeat --json '{"leaseId":"<leaseId>","fence":<fence>}'
pnpm cli task.handback --json '{"leaseId":"<leaseId>","fence":<fence>,"outcome":"completed","report":{}}'
```

`reservationId` comes from the queue; `leaseId` and `fence` from the pickup's
`detail`.

## Output and exit codes

Whatever the API answers, stdout holds its body as received. A JSON body is
re-serialised on one line, and any other body is printed verbatim. A refusal is
printed exactly as the API returned it (`refused`, `code`, `names`, `fixes`).
The one exception is a successful agent `task.pickup`, whose credential is
replaced by where it was saved.

| Exit | Meaning                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Answered: a 2xx with a JSON body. Also `--help`, and a `login` or `logout` that succeeded.                                                     |
| 1    | Refused: the API's body carries `refused: true`. Also a `login` that got no token, whether the identity provider refused it or did not answer. |
| 2    | Usage: an unknown operation (`COMMAND_UNKNOWN`), a bad flag or body, or no bearer or business. No request sent.                                |
| 3    | Transport: no answer arrived.                                                                                                                  |
| 4    | Fault: any other non-2xx, for example a 500 `DECISION_INTEGRITY` or a 503, or an answer that is not JSON.                                      |

## What it does not do

- It does not open the database, read `.local/db.env` or hold a database URL.
- It does not mint, sign or decode a token and never reads `SUPABASE_JWT_SECRET`.
  The bearer is whatever the identity provider issued.
- It does not choose an actor. The server resolves the bearer to a login and
  the path's business to a membership, or refuses.
- It is not the operator tool: no install, backup, restore, migration, seeding,
  service start or stop, or any other host control.
- It has no test-only path. The process proof (`tests/cli/cli-process.test.ts`)
  hands it a bearer through `OPS_ASTRO_TOKEN`, the same way a person does after
  `login`.
