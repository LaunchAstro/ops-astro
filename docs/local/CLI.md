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
pnpm cli login --email ada@alpha.local --second-factor   # then the authenticator code, from stdin or a hidden prompt
pnpm cli task.board --business alpha --json '{"board":null}'
pnpm cli task.create --business alpha --json '{"fields":{"title":"Call the supplier"}}'
pnpm cli task.read --business alpha --body-file ./read.json
pnpm cli logout
```

`node apps/cli/main.ts` runs the same entry without pnpm. `pnpm cli` prints
nothing of its own on stdout, so the output can be piped to `jq`.

## Installing

The entry is executable and starts with `#!/usr/bin/env node`, so a link to it
on your PATH is the installed command. The command needs only a checkout of
the repository and Node 24 or later first on the PATH. It imports nothing
from `node_modules`, so it does not need `pnpm install`.

```sh
mkdir -p ~/.local/bin                     # must be on PATH
ln -sf "$PWD/apps/cli/main.ts" ~/.local/bin/ops-astro
ops-astro help
```

Run the `ln` from the checkout the command should use. Keep that checkout on
`main`; `git pull` there updates the command. `ops-astro` behaves exactly like
`pnpm cli` from that checkout; its help names both.
It keeps its credential files in that checkout's `.local/`, as below.

## Hosted presets

`--env <name>`, or `OPS_ASTRO_ENV=<name>`, points `login`, `logout`, the operations
(`task.board`, `person.list` and the rest), the agent verbs (`task get`,
`task list` and the others below) and the visual operations at a hosted app:

| Preset       | App origin                    |
| ------------ | ----------------------------- |
| `sandbox`    | `https://app.opsastro.com`    |
| `production` | `https://ops.agencyastro.com` |

```sh
ops-astro login --env sandbox --email ada@alpha.local    # prompts for the password
ops-astro task.board --env sandbox --business alpha --json '{"board":null}'
ops-astro logout --env sandbox
```

- The API and the visual operations' pages are the preset's origin.
- `login` asks that origin where to sign in (`GET /api/sign-in`, the web's
  first call) and sends the password only to the https issuer it names, with
  the publishable key it names. A redirect is never followed. Nothing about
  the sign-in service is saved; a preset holds its origin and nothing else.
- Each preset has its own credential files: the usual names with `.<preset>`
  added (`.local/cli-token.sandbox`, or `$OPS_ASTRO_TOKEN_FILE.sandbox`; the
  same for the delegation file). A sandbox bearer is never read for a
  production call, and `logout --env sandbox` leaves production signed in.
- Under a preset the bearer and the delegation come from that preset's files
  only. When its bearer file is missing the command exits 2 with `no bearer`,
  naming `login --env <preset>`; the plain file and the other preset's are
  never read in its place. A stale bearer is sent once, to its own origin,
  and the refusal is final (exit 1).
- A preset replaces the hand-set addresses and credentials. `--env` or
  `OPS_ASTRO_ENV` beside `--api`, `--gotrue`, `--web`, `OPS_ASTRO_API_URL`,
  `OPS_ASTRO_GOTRUE_URL`, `OPS_ASTRO_WEB_URL`, `SUPABASE_PUBLISHABLE_KEY`,
  `OPS_ASTRO_TOKEN` or `OPS_ASTRO_DELEGATION` is refused with exit 2, naming
  both, before anything is read or sent. So is a name that is not a preset.
  The command line can't tell which origin a bearer in the environment was
  issued for, so it never sends one under a preset.
- `--env` wins over `OPS_ASTRO_ENV` when they differ; only the flag's
  preset's files are read.
- The hosted token lasts an hour. After that the API refuses the bearer; run
  `login` again.

### Manual mode

Without a preset, nothing ties a bearer to an origin. The command line never
decodes a token, and the plain files record no origin, so a production bearer
in `OPS_ASTRO_TOKEN` with `OPS_ASTRO_API_URL` set to the sandbox goes to the
sandbox, and the other way round. The person who sets both owns the pairing.
Each setting is read in this order, and the preset files are never read:

| Setting    | Read in this order                                                                   |
| ---------- | ------------------------------------------------------------------------------------ |
| Bearer     | `OPS_ASTRO_TOKEN`, then `$OPS_ASTRO_TOKEN_FILE` or `.local/cli-token`                |
| Delegation | `OPS_ASTRO_DELEGATION`, then `$OPS_ASTRO_DELEGATION_FILE` or `.local/cli-delegation` |
| API        | `--api`, then `OPS_ASTRO_API_URL`, then `http://127.0.0.1:8790`                      |

## Checking a machine against a hosted app

Run these after "Installing", once per machine and preset. Steps 1 to 3 sign in
to nothing, so they are safe to run before anyone has agreed to a sign-in.

1. `ops-astro help` prints the verbs.
2. `curl -s -o /dev/null -w '%{http_code}\n' <origin>/api/health` prints `200`.
3. `ops-astro task.board --env <preset> --business <key> --json '{"board":null}'`
   exits 2 with `no bearer`, sends nothing, and writes nothing. This shows the
   preset has no saved credential, and no other preset's is used.
4. `ops-astro login --env <preset> --email <address>` prompts for the password
   with echo off. It prints `{"ok":true,"saved":".../cli-token.<preset>"}`, and
   that file is mode 600.
5. Step 3's command now exits 0 with `"ok":true`: a read only.
6. `ops-astro logout --env <preset>`, unless the machine should stay signed in.

A refused step 4 prints one line of the command line's own (exit 1) and
saves nothing. After an hour the bearer expires; run step 4 again.

## Credential files

The bearer file, its delegation file and a helper's beside it change only
under these rules (`apps/cli/credentials.ts`), so several `ops-astro`
processes can share them:

- A saved credential is written to a new file, readable by its owner only
  from the start, then renamed over the old one. A reader sees one whole
  credential, never part of one, and new bytes never go into a file someone
  else could read.
- Saves, `logout` and the handback's removal take a lock: the directory
  `<bearer file>.lock`. A command waits up to 3 seconds for it, then stops
  with exit 2 and names it. A lock is only held for local file work, so one
  that stays is left by a crash: remove it if no `ops-astro` is running.
- `logout` records a new sign-out mark (`<bearer file>.epoch`). A `login`,
  pickup or hand-over that was waiting for its answer when a `logout`
  completed saves nothing and says so; a pickup or hand-over names its
  `operationId`, so a replay gets the credential back.
- A handback compares and removes its spent credential under the same lock a
  pickup saves under, so it never removes a newer one.

The operation list comes from `COMMAND_SURFACE`
(`packages/core-wire/src/surface.ts`), the same registry the API
mounts its routes from. The command line answers an operation it does not know on its
own, before it reads the body, business, bearer or API origin and before it
sends any request. It prints
`{"code":"COMMAND_UNKNOWN","names":[<verb>],"fixes":[...]}` and exits 2
(`unknownVerb`, `apps/cli/client.ts`).

## Flags and environment

| Flag                 | Environment                 | Meaning                                                                                                      |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--json <object>`    |                             | The operation's body as a JSON object. Default `{}`.                                                         |
| `--body-file <path>` |                             | The body read from a file. Use one of `--json` and `--body-file`, not both.                                  |
| `--business <key>`   | `OPS_ASTRO_BUSINESS`        | The business key in the path. The server decides whether the login belongs to it.                            |
| `--env <preset>`     | `OPS_ASTRO_ENV`             | A hosted app: `sandbox` or `production` ("Hosted presets"). Not with `--api`, `--gotrue` or `--web`.         |
| `--api <url>`        | `OPS_ASTRO_API_URL`         | The API origin. Default `http://127.0.0.1:8790`.                                                             |
|                      | `OPS_ASTRO_TOKEN`           | The bearer. When unset, the file `login` wrote is used. Refused beside a preset.                             |
|                      | `OPS_ASTRO_TOKEN_FILE`      | Where `login` saves the bearer. Default `.local/cli-token` (owner-only, ignored by Git).                     |
| `--email <address>`  | `OPS_ASTRO_EMAIL`           | `login` only.                                                                                                |
|                      | `OPS_ASTRO_PASSWORD`        | `login` only. When unset, the first line of piped stdin; at a terminal, a prompt with echo off.              |
| `--gotrue <url>`     | `OPS_ASTRO_GOTRUE_URL`      | `login` only. Default `http://127.0.0.1:54391`.                                                              |
|                      | `SUPABASE_PUBLISHABLE_KEY`  | `login` only. The hosted sign-in service's publishable key, sent as `apikey` to it alone.                    |
| `--agent`            | `OPS_ASTRO_AGENT=1`         | Call the agent prefix instead of the person prefix.                                                          |
|                      | `OPS_ASTRO_DELEGATION`      | Agent mode: the delegation credential. When unset, the file a pickup wrote is used. Refused beside a preset. |
|                      | `OPS_ASTRO_DELEGATION_FILE` | Where an agent pickup saves its credential. Default `.local/cli-delegation` (owner-only).                    |
| `--web <url>`        | `OPS_ASTRO_WEB_URL`         | A visual operation only: the app origin its link is under. Default `http://127.0.0.1:5190`.                  |

The bearer and the delegation credential are never taken as flags, so they do
not appear in a process listing or shell history, and the command line never
prints either of them. Every line it prints, on stdout or stderr, has each
credential it sent replaced by `(redacted)`: an answer that echoes one, a
refusal's `code` or `fixes`, a fault's body. Only the exact value is caught,
not an encoded copy; the server's rule against echoing a credential is the
first guard. It writes no log file: stdout and stderr are its only output.

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
writable and send the same body again with the id named on stderr. A
`run.delegate_child` whose helper's credential could not be saved says
`cli: hand-over applied but its helper's credential could not be saved to <file>: <reason>`;
the same body again with that id derives the credential again.

## Person and agent use

**Person.** `login` does the same GoTrue password grant the web sign-in does
(`apps/web/src/session/sign-in.ts`, imported rather than copied) and saves the
access token. Calls go to `/api/b/<business>/...` with that bearer. A hosted
sign-in service refuses a grant without the project's publishable key, and
`login` then says the service needs `SUPABASE_PUBLISHABLE_KEY`. Set it and
`login` sends it as `apikey` to that service alone, never to the API, as the
web does (`withProviderKey`, `apps/web/src/session/provider-key.ts`). A preset
(`--env`) reads the key from the app instead. A refused `login` prints a line
of the command line's own and never the service's words, which can echo what
was sent.

**Second factor.** Once a login has a verified authenticator, a password-only
token is refused wherever the second factor is asked for, the operator gate
included (`scripts/ops/operator.ts`). `login --second-factor` reads the
authenticator code too: the next line of piped stdin (the first when
`OPS_ASTRO_PASSWORD` gives the password), or a second prompt with echo off. It
never takes the code from a flag or the environment. It sends the code to the
person's own account route, `/api/b/<business>/account/factor/verify`, as the
web's code step does, so it needs `OPS_ASTRO_API_URL` (or `--api`, or a
preset's origin under `--env`) and the business, and saves only the token that route answers. A refused code saves
nothing: the half-made sign-in is ended on `account/sessions/sign-out`, and
the exit is 1, naming the refusal code alone.

Every credential file the command line saves (the token, a pickup's or a
helper's delegation) is written to a file of its own beside the target, made
owner-only, then renamed over it: a reader sees the old file or the whole new
one, and a link at the target is replaced, never written through.

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
(`task.heartbeat`, `task.read`, `task.comment`, `model.call`, `task.handback`) send it in the
`x-agent-delegation` header. A successful `task.handback` removes the file when
it holds the credential that handback was sent with. A handback sent with
another credential through `OPS_ASTRO_DELEGATION`, such as a replay of an older
lease, leaves the saved one alone (`tests/cli/cli-delegation-replay.test.ts`).
A successful `run.delegate_child` (AW-11) saves the helper's credential to
`<delegation file>.child-<childDelegationId>`, owner-readable only, and prints
the answer with it replaced by `(saved to <file>)`; the parent's own file is
left alone. The helper sends it with `OPS_ASTRO_DELEGATION` for its calls and
its `run.child_handback`.

```sh
export OPS_ASTRO_AGENT=1 OPS_ASTRO_BUSINESS=alpha
pnpm cli task.queue
pnpm cli task.pickup --json '{"reservationId":"<reservationId>","operationId":"<your-id>"}'
pnpm cli task.heartbeat --json '{"leaseId":"<leaseId>","fence":<fence>}'
pnpm cli model.call --json '{"leaseId":"<leaseId>","fence":<fence>,"operation":"model.replay_compose","fields":[{"name":"tone","from":{"recordId":"<taskId>","key":"title"}}]}'
pnpm cli task.handback --json '{"leaseId":"<leaseId>","fence":<fence>,"outcome":"completed","report":{}}'
pnpm cli run.delegate_child --json '{"leaseId":"<leaseId>","fence":<fence>,"helperActorId":"<agentActorId>","purpose":"draft_help","collections":["task"],"actions":["read"],"expiresInSeconds":600}'
OPS_ASTRO_DELEGATION="$(cat <delegation file>.child-<childDelegationId>)" pnpm cli run.child_handback --json '{"outcome":"completed"}'
```

A person answers a run waiting at its approved ceiling on the person prefix
(AW-05), naming the stop they answer (`askId`, from `task.read`'s ledger). The
top-up is in the currency's minor units; above the business's four-eyes
threshold a second person sends the same body to complete it.

```sh
pnpm cli run.top_up --json '{"recordId":"<taskId>","runId":"<runId>","askId":"<askId>","amountMinor":1000,"currency":"AUD"}'
pnpm cli run.end_at_budget_stop --json '{"recordId":"<taskId>","runId":"<runId>","askId":"<askId>"}'
pnpm cli run.revise_state --json '{"recordId":"<taskId>","runId":"<runId>","expectedVersion":0,"knowledge":["the brief is agreed"],"unknowns":["the launch date"]}'
```

A person makes their own agent, renames it, lists their agents, and hands it
a task on the person prefix. The task keeps the agent until a person assigns
it again; assigning starts no run.

```sh
pnpm cli agent.create --json '{"name":"Reply drafter"}'
pnpm cli agent.rename --json '{"agentId":"<agentId>","name":"Inbox drafter"}'
pnpm cli agent.mine
pnpm cli task.assign --json '{"recordId":"<taskId>","expectedRevision":<revision>,"fields":{"agent":"<agentId>"}}'
```

`reservationId` comes from the queue; `leaseId` and `fence` from the pickup's
`detail`. `operationId` is optional on each of them; naming your own lets you
send the same body again after a lost answer and get the replay.

## Visual operations

Some operations are a page someone looks at, not a request with an answer.
The command line's honest answer to one is the address of the app's page for
it (AW-09; `VISUAL_HANDOFFS`, `packages/core-wire/src/handoff.ts`). It sends
nothing and needs no bearer or business: the page asks for its own session
and reads through its own commands.

```sh
pnpm cli review.view --json '{"key":"T-12"}'
# {"handoff":"http://127.0.0.1:5190/task/T-12","operation":"review.view","why":"..."}
```

`review.view` is the review round's page: the agent's output and its stored
evidence beside the version history, the rounds used and the decisions on
offer. `task.read` answers the same facts as JSON, and `task.decide` makes
each decision. The body holds the route's one parameter and nothing else; a
key that is not one path segment (letters, digits, `.`, `_` or `-`, at most
64), an undeclared field, or an origin with a path, query, credentials or a
scheme other than http or https is refused with `FIELD_VALUE_INVALID` and exit 2. `--help` lists the visual operations after the others, and
`scripts/command-parity.mjs` fails a hand-off whose route the app does not
register or whose name is a command's.

## Output and exit codes

Whatever the API answers, stdout holds its body as received. A JSON body is
re-serialised on one line, and any other body is printed verbatim. A refusal is
printed exactly as the API returned it (`refused`, `code`, `names`, `fixes`).
The one exception is a successful agent `task.pickup`, whose credential is
replaced by where it was saved.

| Exit | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Answered: a 2xx with a JSON body. Also `--help`, and a `login` or `logout` that succeeded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 1    | Refused: the API's body carries `refused: true`. Also a `login` that got no token, whether the identity provider refused it or did not answer, or whose save a `logout` overtook. Its line is the command line's own, never the provider's words.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2    | Usage: an unknown operation (`COMMAND_UNKNOWN`), a bad flag or body (including a number with no canonical form, such as `1e400`, which the command line refuses rather than sending as `null`), no bearer or business, an agent `task.pickup` whose delegation file (`OPS_ASTRO_DELEGATION_FILE`) cannot be written, a `login` whose token file (`OPS_ASTRO_TOKEN_FILE`) cannot be written, a preset beside a hand-set address or credential, a flag no verb names, or credentials another command holds locked. No request sent.                                                                                                                                                                                                                  |
| 3    | Transport: no answer arrived.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4    | Fault: any other non-2xx, for example a 500 `DECISION_INTEGRITY` or a 503, or an answer that is not JSON. Also an agent `task.pickup` that the API applied but whose credential could not be saved (stderr names the operationId); an agent `run.delegate_child` whose helper's credential could not be saved (the same); an agent `task.handback` that the API applied but whose spent credential could not be removed (stdout carries the answer; stderr names the operationId, and a replay with it removes the file); a `login` whose issued token could not be saved; a `logout` that could not remove a credential file (stderr names it); and `cli: internal fault`, a failure nothing else expected, whose own text and stack never print. |

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

## The agent verbs (API-3)

Verbs for people and delegated agents, each one request to its owning operation
(`apps/cli/verbs.ts`); the CLI adds no rule, and a refusal is one line naming
the missing key.

```
pnpm cli help
pnpm cli task get <id> [--detail brief|standard|full] [--history-event <id>] [--fields a,b] [--json]
pnpm cli task list [--board <id> | --mode aggregate] [--person <id>] [--client <id>] [--limit n] [--page <next>] [--detail ...]
pnpm cli task create --title <t> [--description <d>] [--parent <id>] [--board <id>] [--type <type>]
pnpm cli task update <id> --revision n [--title <t>] [--description <d>]
pnpm cli task comment <id> --revision n --text <t> [--audience internal|client]
pnpm cli task block <id> --revision n --blocked-by a,b
pnpm cli task claim <id> --revision n
pnpm cli task resolve <id> --revision n --answer <t> --gist <t>
pnpm cli task close <id> --revision n --reason <t>
pnpm cli map chart --body-file <path>
pnpm cli map graduate <id> --revision n --patch <id> --body-file <path>
pnpm cli map view|frontier <id>
pnpm cli map list
```

- Connection flags (`--business`, `--agent`, `--env`, `--api`), environment
  and exit codes are an operation's, in either form, `--env sandbox` or
  `--env=sandbox`. A flag no verb names is refused with exit 2, never dropped,
  so a misspelt `--envv production` can't leave the line on `OPS_ASTRO_ENV`. A verb flag's value is
  taken as given, even one that starts with `--`: in
  `--description --env=production` it is the description, never the preset.
  Every refusal that needs no credential comes before one is read. A write
  prints `ok <operation> <id> r<revision>`; on no answer or a fault it prints
  its `operationId`, and the same line with `--operation <id>` replays it.
- `brief` is id, title and state; `standard` (default) adds the summary,
  description, blockers and latest five comments; `full` is everything. An
  external party gets the same levels of its shared view. Unreadable blockers
  are never listed: an agent gets their count, a record-grant member none.
- `task list` pages by `QUOTAS.pageSize` (20, at most 100). `next: <token>`
  goes back as `--page`; a list reordered before the token, or missing a task
  it showed, refuses it (`FIELD_VALUE_INVALID` on `page`): list again.
- The API takes `detail`, `limit` and `page` on `task.read` and `task.board`.
- `task get <id> --history-event <id>` looks up one entry of the task's
  history as `historyEvent` (null when the history holds none). It reads the
  full detail unless `--detail` says otherwise.

`task list --mode aggregate` reads open tasks across boards and unboarded
tasks. `--person <UUID>` and `--client <UUID>` intersect that pool or a selected
`--board`. With no board or mode, the pool is unboarded. The API admits these
scopes; the CLI adds no authority rule. Combining board and aggregate mode
is refused by the API. The low-level `task.board --json` form accepts the same
body, including ordinary unpaged reads when no paging operands are sent.
