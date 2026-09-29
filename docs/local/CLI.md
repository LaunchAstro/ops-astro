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
pnpm cli login --email ada@alpha.local   # prompts for the password (echo off), or reads OPS_ASTRO_PASSWORD or piped stdin
pnpm cli task.board --business alpha --json '{"board":null}'
pnpm cli task.create --business alpha --json '{"fields":{"title":"Call the supplier"}}'
pnpm cli task.read --business alpha --body-file ./read.json
pnpm cli logout
```

`node apps/cli/main.ts` runs the same entry without pnpm. `pnpm cli` prints
nothing of its own on stdout, so the output can be piped to `jq`.

The operation list comes from `COMMAND_SURFACE`
(`packages/core-wire/src/surface.ts`), the same registry the API
mounts its routes from. The command line answers an operation it does not know on its
own, before it reads the body, business, bearer or API origin and before it
sends any request. It prints
`{"code":"COMMAND_UNKNOWN","names":[<verb>],"fixes":[...]}` and exits 2
(`unknownVerb`, `apps/cli/client.ts`).

## Flags and environment

| Flag                 | Environment                 | Meaning                                                                                         |
| -------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `--json <object>`    |                             | The operation's body as a JSON object. Default `{}`.                                            |
| `--body-file <path>` |                             | The body read from a file. Use one of `--json` and `--body-file`, not both.                     |
| `--business <key>`   | `OPS_ASTRO_BUSINESS`        | The business key in the path. The server decides whether the login belongs to it.               |
| `--api <url>`        | `OPS_ASTRO_API_URL`         | The API origin. Default `http://127.0.0.1:8790`.                                                |
|                      | `OPS_ASTRO_TOKEN`           | The bearer. When unset, the file `login` wrote is used.                                         |
|                      | `OPS_ASTRO_TOKEN_FILE`      | Where `login` saves the bearer. Default `.local/cli-token` (owner-only, ignored by Git).        |
| `--email <address>`  | `OPS_ASTRO_EMAIL`           | `login` only.                                                                                   |
|                      | `OPS_ASTRO_PASSWORD`        | `login` only. When unset, the first line of piped stdin; at a terminal, a prompt with echo off. |
| `--gotrue <url>`     | `OPS_ASTRO_GOTRUE_URL`      | `login` only. Default `http://127.0.0.1:54391`.                                                 |
| `--agent`            | `OPS_ASTRO_AGENT=1`         | Call the agent prefix instead of the person prefix.                                             |
|                      | `OPS_ASTRO_DELEGATION`      | Agent mode: the delegation credential. When unset, the file a pickup wrote is used.             |
|                      | `OPS_ASTRO_DELEGATION_FILE` | Where an agent pickup saves its credential. Default `.local/cli-delegation` (owner-only).       |

The bearer and the delegation credential are never taken as flags, so they do
not appear in a process listing or shell history, and the command line never
prints either of them.

A write needs an `operationId`; when the body has none, the command line adds a
fresh one. A read on the person prefix is sent with exactly the body given and
no `operationId`. Every call on the agent prefix (`--agent`) gets one, reads
included, because the agent envelope refuses any call without it
(`OPERATION_ID_REQUIRED` in `runAgentCommand`,
`packages/core-commands/src/commands/agent-envelope.ts`). To retry a write
safely, put your own `operationId` in the body and send the same body again.
The API replays the first answer instead of writing twice. When the command
line chose the `operationId` and the call gets no answer (exit 3) or a fault
(exit 4), stderr names it:
`cli: operationId <id>; send it again with this operationId to replay`. Put
that id in the body and send it again (`replayHint`, `apps/cli/main.ts`).
A pickup that was applied but whose credential could not be saved (exit 4)
also names its operationId, including one the caller supplied:
`cli: pickup applied but its credential could not be saved to <file>: <reason>`.
Make the location writable and send the same body again with that id to get
the credential back. The same applies to an agent `task.handback` that was
applied but whose saved credential could not be removed: make the location
writable and send the same body again with the id named on stderr.

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
pnpm cli task.pickup --json '{"reservationId":"<reservationId>","operationId":"<your-id>"}'
pnpm cli task.heartbeat --json '{"leaseId":"<leaseId>","fence":<fence>}'
pnpm cli task.handback --json '{"leaseId":"<leaseId>","fence":<fence>,"outcome":"completed","report":{}}'
```

`reservationId` comes from the queue; `leaseId` and `fence` from the pickup's
`detail`. `operationId` is optional on each of them; naming your own lets you
send the same body again after a lost answer and get the replay.

## Output and exit codes

Whatever the API answers, stdout holds its body as received. A JSON body is
re-serialised on one line, and any other body is printed verbatim. A refusal is
printed exactly as the API returned it (`refused`, `code`, `names`, `fixes`).
The one exception is a successful agent `task.pickup`, whose credential is
replaced by where it was saved.

| Exit | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Answered: a 2xx with a JSON body. Also `--help`, and a `login` or `logout` that succeeded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 1    | Refused: the API's body carries `refused: true`. Also a `login` that got no token, whether the identity provider refused it or did not answer.                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2    | Usage: an unknown operation (`COMMAND_UNKNOWN`), a bad flag or body (including a number with no canonical form, such as `1e400`, which the command line refuses rather than sending as `null`), no bearer or business, an agent `task.pickup` whose delegation file (`OPS_ASTRO_DELEGATION_FILE`) cannot be written, or a `login` whose token file (`OPS_ASTRO_TOKEN_FILE`) cannot be written. No request sent.                                                                                                                                               |
| 3    | Transport: no answer arrived.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 4    | Fault: any other non-2xx, for example a 500 `DECISION_INTEGRITY` or a 503, or an answer that is not JSON. Also an agent `task.pickup` that the API applied but whose credential could not be saved (stderr names the operationId); an agent `task.handback` that the API applied but whose spent credential could not be removed (stdout carries the answer; stderr names the operationId, and a replay with it removes the file); a `login` whose issued token could not be saved; and a `logout` that could not remove a credential file (stderr names it). |

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

## Wayfinder maps

A map is a task of type `map`; its tickets are its subtasks (WF-1, WF-2). The
same verbs as every other command, each one call:

```sh
pnpm cli map.chart --json '{"title":"Onboarding","destination":"A signed-off flow","tickets":[{"ref":"a","title":"Find the rules","type":"research"},{"ref":"b","title":"Choose the flow","type":"grilling","blockedBy":["a"]}],"fog":["Who approves?"]}'
pnpm cli map.view --json '{"recordId":"<mapId>"}'
pnpm cli map.frontier --json '{"recordId":"<mapId>"}'
pnpm cli task.claim --json '{"recordId":"<ticketId>","expectedRevision":1}'
pnpm cli task.resolve --json '{"recordId":"<ticketId>","expectedRevision":2,"answer":"...","gist":"one line"}'
```

`task.create` takes `taskType` (map, research, prototype, grilling, task or
build; `task` when absent). `task.set_type`, `map.revise`, `map.scope`,
`task.set_blocking`, `map.graduate` and `task.close_out_of_scope` complete the
set. A grilling or prototype ticket is retyped or resolved only by the map's
owner, holding `task:decide`. An agent reaches none of these yet: they wait on
the agent credential narrowed from a person's grants (API-2).

## The agent verbs (API-3)

A small general set on top of the operations, for people and delegated agents
alike. Each verb maps onto its owning operation (`apps/cli/verbs.ts`) and is
one request; the CLI adds no rule, so a refusal is the server's, printed in one
line that names the missing key when it is about authority.

```
pnpm cli help
pnpm cli task get <id> [--detail brief|standard|full] [--fields a,b] [--json]
pnpm cli task list [--board <id>] [--limit n] [--page <next>] [--detail ...]
pnpm cli task create --title <t> [--description <d>] [--parent <id>] [--board <id>] [--type <type>]
pnpm cli task update <id> --revision n [--title <t>] [--description <d>]
pnpm cli task link <id> --revision n --blocked-by <id,id>
pnpm cli task comment <id> --revision n --text <t> [--audience internal|client]
pnpm cli task resolve <id> --revision n --answer <a> --gist <one line>
pnpm cli task context <id> [--detail brief|standard|full]
pnpm cli map view <id>
pnpm cli map status <id> [--detail brief|standard|full]
pnpm cli map frontier <id>
```

- `--business`, `--api` and `--agent` and the environment work as for an
  operation. Exit codes are the same.
- A write prints `ok <operation> <id> r<revision>`; pass that revision to the
  next write on the same task.
- Reads take a detail level. `brief` is id, title and state. `standard` (the
  default) adds the summary, description, blockers and the latest five
  comments. `full` is everything, the whole thread and history included. A
  blocker the reader may not read is never listed: it is counted as
  `blockersWithheld`.
- Output is terse text. `--json` prints minimal JSON, and `--fields` keeps only
  the fields named.
- `task list` pages 20 at a time (at most 100 with `--limit`). A page ends with
  `next: <token>`; pass it as `--page` for the next one. A task added meanwhile
  joins a later page, and none repeats.
- The API takes the same `detail`, `limit` and `page` body fields on
  `task.read` and `task.board`. Without them it answers as before.
- `task list` takes at most 100 a page, and every call counts against the
  caller's quotas (`identity/quota.ts`): past one, the call is refused
  `QUOTA_EXCEEDED` with when to send again.
- `map status` (API-4, `map.status`) is the map's frontier, fog and counts in
  one call, from one query on the map's read models, so it is current after
  any write. `full` carries every id; `standard` names a frontier ticket by
  key, title and type; `brief` keeps the counts and the keys.
- `task context` (API-4, `task.context`, _work this ticket_) is everything a
  ticket depends on in one call and one statement: the ticket, its map's
  Destination and Decisions so far, its blockers and what it blocks, its
  acceptance checks (the `- [ ]` and `- [x]` lines of its description, as
  written), its linked documents (none yet: they join with WF-8's Docs pages)
  and its recent thread. It reads the live tables the write changed, so it is
  current after any write. A part the reader may not read is left out and
  counted under `withheld` (`map`, `blockedBy`, `blocks`), never listed. `full`
  carries every id and the whole thread; `standard` keeps the ticket's own id
  (writes take it), names the tickets around it by key and title, and carries
  the latest five comments; `brief` is names and state and no thread bodies.
  Internal readers only; an agent reaches it once its credential is narrowed
  from a person's grants (API-2).
- _Changes since_ joins with the live change record (C4).

## The wayfinder tracker (API-5)

`docs/agents/issue-tracker-ops-astro.md` is the tracker file the upstream
wayfinder and grilling skills read, beside their `issue-tracker-github.md` and
`issue-tracker-local.md`: point a project's tracker at it and the skills run
unmodified against Ops Astro. Every operation it names is one of the verbs
above or one of these (`apps/cli/tracker-verbs.ts`), each onto its owning
wayfinder command:

```
pnpm cli map chart --title <t> [--destination <d>] [--notes <n>] [--fog <json list>] [--tickets <json list>] [--out-of-scope <json list>]
pnpm cli map revise <map> --revision n [--destination <d>] [--notes <n>] [--add-fog <json list>] [--add-out-of-scope <json list>] [--retire <id,id>]
pnpm cli map graduate <map> --revision n --patch <fog id> --tickets <json list>
pnpm cli task claim <id> --revision n
pnpm cli task type <id> --revision n --type <type>
pnpm cli task out-of-scope <id> --revision n --reason <r>
pnpm cli task close <id> --revision n
pnpm cli task research <id>
```

- List operands (fog lines, tickets) are JSON lists; a flag that is not one is
  a usage error before any request.
- `map chart --tickets` takes `{ref, title, type, blockedBy}` entries and
  prints each ref with the ticket it became (`a=<id>`); `map graduate` prints
  its tickets in order (`1=<id>`).
- `task research` answers `NOT_AVAILABLE` ("not available until Docs"), exit 1,
  and sends nothing: a research artefact is a Docs page, which arrives with
  WF-8. There is no other store for it.
- The tracker's mapping table is the spec's (`CAPABILITY-SLICES.md` section
  15a, copied in `tests/cli/api-5-spec-mapping.md`); the upstream skill files
  are pinned by SHA-256 in the tracker file. `tests/cli/api-5-contract.test.ts`
  fails when either drifts, and `tests/cli/api-5-conformance.test.ts` runs the
  same wayfinding script against the local-Markdown tracker and Ops Astro.
- A ticket ruled out of scope is an Out of scope item and stays out of
  Decisions so far, in `map view` and in `task context`.
