# The local slice

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

How to start the task slice on your own machine, how to check it, and what it
does not do. Six companion files describe the parts:

- [DATA.md](DATA.md): the Postgres, the migrations, the fixed slots, the seed.
- [API.md](API.md): the HTTP boundary, its routes, its envelope and its refusals.
- [AUTHORITY.md](AUTHORITY.md): credentials, membership, grants and delegation.
- [RUNTIME.md](RUNTIME.md): propose, decide, pick up, hand back, recover.
- [WEB.md](WEB.md): the screens, their tests and the gaps against the mockup.
- [PROOFS.md](PROOFS.md): the assembled acceptance proofs in `tests/acceptance/`,
  how to run them, and the proofs that could not be written.

New here? [Pickup and debugging](#pickup-and-debugging) is the short version:
how a request travels, what to check before restarting anything, which command
proves what, and what a bug report has to carry.

## Pick up here

If you are new to this checkout, read this section first.

- **Where state lives in the repository.** How the slice is built:
  `docs/local/` (this file and the six above). Settled decisions:
  `docs/current-decisions.md` and `docs/adr/`. Demonstrated failures that have
  no executable check yet: `docs/TRAPS.md`. The proofs:
  `tests/acceptance/`, described in [PROOFS.md](PROOFS.md). The database suites
  that conformance must run: `tests/db/named-suites.json`.
- **Where state does not live.** Run status, reviews and acceptance records are
  kept with the build run's evidence, outside the tree. A checkout may carry an
  ignored `.local/run-context.json` that points there ([below](#the-optional-local-run-pointer)).
  If it is missing, nothing about completion follows from that.
- **Implemented, tested, accepted.** These are three different claims.
  Implemented means the code is on the branch. Tested means a named command
  passed on a merge trial. Accepted means a review recorded it against a head.
  [PROOFS.md](PROOFS.md#current-counts-and-what-they-are) labels each count. No
  count in this repository is an acceptance.
- **Start the stack.** Follow [Start it](#start-it). If another person or lane
  already uses the default ports on this machine, give your stack its own ports
  and database instead of sharing theirs.
- **One command to check it.** `corepack pnpm verify:slice` prints one line per
  case. Any `unrun` line comes with its reason.
- **The command line.** `corepack pnpm cli <operation>` calls the same API as
  the app, as a person or (with `--agent`) as an agent; see [CLI.md](CLI.md).
- **Stop only what you started.** Record the PIDs you start and kill only those
  PIDs. Never kill by pattern ([Stopping what you started](#stopping-what-you-started)).
- **The delegation credential key.** Agent pickup credentials are derived
  under a local key kept outside the database and outside tracked files: the
  environment (`DELEGATION_CREDENTIAL_KEY_ID` and `DELEGATION_CREDENTIAL_KEYS`)
  or the ignored `.local/delegation.env`. `db:seed` creates that file once, or
  the API creates it on first use, and neither rewrites it. Back it up with the
  database; a database restored without it cannot replay a lost pickup
  response ([RUNTIME.md](RUNTIME.md#the-delegation-credential-key)).
- **The seed can change the external party's password.** See
  [the external party's login](#the-external-partys-login) before you run
  `db:seed` against an identity service someone else uses.

Everything here is local. Every container and every process listens on a
loopback address of this machine. Nothing is deployed, nothing is published,
and no hosted service is involved at any point.

## Prerequisites

- **Node 24.** The major is pinned in `.nvmrc`. The API runs its TypeScript
  directly under Node's own type stripping, so 24 is the floor rather than a
  preference.
- **pnpm through corepack.** The version is pinned in `package.json`. Use
  `corepack pnpm …` and there is nothing to install globally.
- **Docker.** Postgres and GoTrue run as containers from digests pinned in
  `docs/supply-chain-pins.md`.

Then install the workspace once, from the repository root:

```
corepack pnpm install
```

`pnpm check` additionally wants Python 3.11 or newer, Git and Gitleaks; the
slice itself does not.

## Start it

In order. Each step is idempotent: running it twice is running it once.

```
corepack pnpm db:up && corepack pnpm db:migrate && corepack pnpm auth:up \
  && corepack pnpm auth:seed && corepack pnpm db:seed
```

- `db:up` starts the Postgres container on `127.0.0.1:54390` against a named
  volume, creates the migration and runtime roles, and writes `DATABASE_URL`
  and `DATABASE_ADMIN_URL` to `.local/db.env`.
- `db:migrate` applies the migrations and records them in the ledger.
- `auth:up` starts GoTrue on `127.0.0.1:54391` and writes `.local/auth.env`.
- `auth:seed` mints the synthetic logins and writes `.local/synthetic-users.json`.
- `db:seed` maps those subjects to people, memberships and grants. It seeds no
  task: a seeded task is a task nobody created, and it would make the
  acceptance cases pass without the product working.

Before the API starts, name the installation's businesses for restart
recovery in `.local/recovery.env` (gitignored, read by `apps/api/server.ts`
beside the other `.local` files; the real environment wins). The seeded local
install is `alpha` and `bravo`:

```
printf 'RECOVERY_BUSINESS_KEYS=alpha,bravo\n' > .local/recovery.env
```

The API refuses to start without it. Every start and restart of the API process
replays each named business's recorded, unclassified transitions in its own
transaction before it binds the port (`docs/local/RUNTIME.md`, "Restart
recovery at API startup"). `RECOVERY_BUSINESS_KEYS=none` is the only way to say
there are none, and the server logs `restart recovery: explicitly no
installation businesses` when it is used; a blank or missing value is a failed
start, never an empty scope. `scripts/local/api-up.sh` needs no argument for
it.

Then the two servers, each in its own terminal or backgrounded:

```
corepack pnpm api:up    # http://127.0.0.1:8790
corepack pnpm web:up    # http://127.0.0.1:5190
```

Open **`http://127.0.0.1:5190/`**. The web server proxies `/api` to the API, so
the browser only ever makes same-origin requests.

`corepack pnpm db:down` stops the database container. It keeps the named
volume, so the data survives.

## Signing in

The synthetic logins live in **`.local/synthetic-users.json`**, written by
`auth:seed`. That file is gitignored and holds the email addresses, passwords
and GoTrue subjects; read it there. No password appears in this repository,
and none should be pasted into one.

`auth:seed` writes five of them:

| Login                | Business |
| -------------------- | -------- |
| `ada@alpha.local`    | alpha    |
| `mia@alpha.local`    | alpha    |
| `noah@alpha.local`   | alpha    |
| `orphan@alpha.local` | alpha    |
| `bea@bravo.local`    | bravo    |

Addresses, not contact details: `.local` is reserved for multicast DNS by RFC
6762 and cannot be delegated, so none of them reaches a mailbox. The public
content check allows exactly these five by name
(`scripts/public-content-check.mjs`, `publishedAddresses`), so a sixth
invented login is a finding until it is added here and there.

Two businesses, keys `alpha` and `bravo`. The business selector on the sign-in
page chooses the `/api/b/<key>` route prefix; it is a routing choice, not a
claim, and the API resolves who you are and what you may see server-side.
[DATA.md](DATA.md) names which identities carry which negative case.

### The external party's login

`db:seed` adds a sixth login to the same file: the external party (R4), with
`role: 'external'` (`scripts/local-seed.mjs`, `ensureExternalEntry` and
`seedExternalUser`). Its address is built at seed time rather than written
down, so it is not listed above. Read it from the file.

The seed writes this entry only when the file does not already have one. When
it writes one, it generates a new password and sets that user's password in
GoTrue to match. So if the file has no external entry, for example because
`auth:seed` rewrote it, re-seeding resets the external party's password in
GoTrue. Anyone else who signs in as that user against the same GoTrue then
holds a stale password. If your stack shares an identity service with another
checkout, copy that checkout's existing external entry into your
`.local/synthetic-users.json` before you run `db:seed`.

## Verify it

```
corepack pnpm verify:slice
```

Signs in through the local GoTrue and walks create, start, complete, reopen
and edit over HTTP, then the refusals: a foreign business, a fabricated id, a
login with no membership, a replayed operation identity, a stale revision,
writes to protected and system fields, and a body carrying an actor and a
business that reach nothing. One line per case with the status and the code it
observed; a case that cannot run prints `unrun` with its reason.

```
mkdir -p .local/evidence/browser
SHOT_DIR="$PWD/.local/evidence/browser" DOCKER_BIN="$(command -v docker)" \
  corepack pnpm verify:browser
```

`SHOT_DIR` is where the screenshots and `RESULTS.md` are written. Set it: the
harness's default is a directory beside this repository rather than inside it,
so an unset `SHOT_DIR` writes outside your checkout. `DOCKER_BIN` defaults to
`/usr/local/bin/docker`, which is not where every installation puts it.
`WEB_URL` and `API_URL` override the two addresses if you moved them. The same
four apply to `node tests/browser/keyboard-and-widths.mjs`.

Drives the browser acceptance cases through Playwright against the running
application, so start the database, the identity service, the API and the web
server first. The N6 revocation cases (a grant revoked underneath a live
session, and an older in-flight response that cannot restore it) are part of
that command: `tests/browser/slice-acceptance.mjs` runs them through
`cases-n6-n7.mjs`, which imports `n6-revocation.mjs`. One further harness is
not in that command and runs on its own: `node tests/browser/keyboard-and-widths.mjs`
(keyboard paths, and the width captures the gaps below are recorded from).
Running `node tests/browser/n6-revocation.mjs` alone revokes a grant that the
caller normally restores; run `corepack pnpm db:seed` afterwards.

```
corepack pnpm build
```

Builds the web bundle into `apps/web/dist` by running that application's own
`vite build`, and names every workspace directory it does not build. The API is
not built because it has no build step; `packages/ui` and
`packages/core-records` are compiled into the web bundle from source. The build
packages nothing and deploys nothing.

```
corepack pnpm check
```

The whole blocking gate, tests included. The test suite needs `DATABASE_URL`
and `DATABASE_ADMIN_URL` exported, and the public-content step reads the
**staged** tree, so stage your changes before running it.

## Pickup and debugging

Enough to find your way to the code that is wrong, and to write a report the
next person can act on.

### How a request travels

The screen calls the shared operation client in `apps/web/src/operations/client.ts`,
which posts to `/api/b/<business-key>/<command path>` with the session's token
and nothing else identifying the caller. The API in `apps/api/app.ts` resolves
that token to a verified subject and then to a session through
`packages/core-records/src/identity/login-resolution.ts`, so who you are is
what the token says, never what the body claims: [AUTHORITY.md](AUTHORITY.md)
has the three credentials and what each confers. The route itself is derived
from `COMMAND_SURFACE` in `packages/core-records/src/commands/surface.ts`, so a
command with no declaration has no route, and a read is a declaration with
`kind: 'read'` that carries no `operationId` and no `expectedRevision`
([API.md](API.md)). The handler prepares and applies the write against the
fixed-slot records in `packages/core-records/src/records/`, or, for the
proposal and decision path, against `packages/core-runtime/`
([DATA.md](DATA.md), [RUNTIME.md](RUNTIME.md)). All of it commits inside one
tenancy transaction opened by `withSession`, which sets the business on the
connection and checks the grant in the same transaction as the write, which is
why a revoked grant bites on the very next call.

### Before you restart anything

A slice that "does not work" is usually a process answering that is not the one
you think you are editing. Ask three questions in this order.

```sh
curl -s http://127.0.0.1:8790/api/health   # is anything answering, and is the database reachable
lsof -nP -iTCP:8790 -sTCP:LISTEN           # which process is actually listening
lsof -nP -iTCP:5190 -sTCP:LISTEN           # and the web server

api_pid=$(lsof -nP -iTCP:8790 -sTCP:LISTEN -t)
lsof -a -p "$api_pid" -d cwd -Fn           # which checkout that process is serving
```

`/api/health` runs a statement and answers `200` with `database: "reachable"`
or `503` with the reason, and it reports whether the read half of the surface
is mounted. It does not say which checkout the process was started from, and
neither does starting the API again: `scripts/local/api-up.sh` checks
`/api/health` first and exits `0` with "something is already answering" when it
gets a reply, so a successful `pnpm api:up` is not evidence that your code is
being served. The listener's working directory is what settles it: `-t` gives
the pid on its own, and the last `lsof` prints that process's directory on a
line beginning with `n`, on both macOS and Linux. If it is not the checkout you
are editing, you are reading one tree and testing another.

### Stopping what you started

Several stacks can run on one machine at the same time, and their API processes
look alike. On 23 September a cleanup with `pkill -f apps/api/server.ts`
matched a shared API that other people were using, and stopped it
([TRAPS.md](../TRAPS.md)). So:

- When you start a process, record its PID. After a backgrounded command, that
  is `$!`. For a listener, use `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` on your
  own port.
- Before you stop it, confirm it is still yours:
  `lsof -a -p <pid> -d cwd -Fn` prints its working directory.
- Stop it with `kill <pid>`. Never use `pkill`, `killall` or any other
  pattern-based kill, and never stop a listener on a port you did not start.

### Where the output goes

`pnpm api:up` and `pnpm web:up` both run in the foreground and print to the
terminal you started them in. Neither writes a log file and neither writes a
pid file: if you want a detached process, the redirection and the pid file are
yours to choose, and no other file in this repository will know where you put
them. The web server prints its three addresses on start; the API prints the
one it is listening on.

### The four kinds of verification

They prove different things and fail for different reasons. Reaching for the
slowest one first is the usual mistake.

| Kind                 | Command                                                                                                                                      | Needs                                                                                                                                                                                    | Notes                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mounted web tests    | `corepack pnpm exec vitest run tests/surfaces`                                                                                               | Nothing running                                                                                                                                                                          | Screens under jsdom, in about a second. The first thing to run.                                                                                                    |
| HTTP                 | `corepack pnpm verify:slice`                                                                                                                 | Database, GoTrue, API                                                                                                                                                                    | Signs in for real and walks the create/start/complete path and the refusals. One line per case; `unrun` with a reason for a case that cannot run.                  |
| Browser              | `mkdir -p .local/evidence/browser && SHOT_DIR="$PWD/.local/evidence/browser" DOCKER_BIN="$(command -v docker)" corepack pnpm verify:browser` | The whole stack, plus Playwright's Chromium downloaded                                                                                                                                   | Has side effects, below.                                                                                                                                           |
| Database conformance | `corepack pnpm db:conformance`                                                                                                               | Docker, and both database URLs exported: `set -a; . ./.local/db.env; set +a` puts `DATABASE_URL` and `DATABASE_ADMIN_URL` in the environment ([DATA.md](DATA.md#roles-and-the-two-urls)) | Runs the suites named in `tests/db/named-suites.json` and fails a run in which one skipped. [What each of its two jobs proves](../agents/database-conformance.md). |

`chromium.launch()` in `tests/browser/slice-acceptance.mjs` needs a browser on
disk, and installing the `playwright` package does not fetch one. Run
`corepack pnpm exec playwright install chromium` once.

The browser command is the one to be careful with. It restarts the API and the
Postgres container, and the N6 cases issue a live grant and revoke it again, so
it changes the state of the running stack while it runs. Two of them at once
would fight over the same containers and the same port: **on a shared run, the
browser suite gets one slot at a time**, and whoever is coordinating the run
hands that slot out. Running `node tests/browser/n6-revocation.mjs` on its own
revokes a grant the caller normally restores; run `corepack pnpm db:seed`
afterwards.

`corepack pnpm check` is the blocking gate rather than a fifth kind: it runs
the tooling checks and the test suite together, wants `DATABASE_URL` and
`DATABASE_ADMIN_URL` exported, and reads the **staged** tree for its
public-content step.

### The optional local-run pointer

A checkout may carry an ignored `.local/run-context.json`. When it exists it
holds pointers and nothing else:

| Key                    | Meaning                                             |
| ---------------------- | --------------------------------------------------- |
| `goal_key`             | The identifier of the run this checkout belongs to. |
| `run_root`             | The directory holding that run's private state.     |
| `integration_worktree` | The checkout the run integrates into.               |
| `integration_branch`   | The branch in it.                                   |
| `state_entry`          | The file in `run_root` to read first.               |

It is a signpost to a coordinator's live state held outside this repository,
and it carries no status, no results and no credentials. **Its absence means
there is no local-run metadata here.** It does not mean the work is finished,
and no completion may be inferred from it either way. If the file is present
and the directory it names is not, the pointer is stale: say so in your report
rather than guessing what it meant.

### Reporting a bug or handing back evidence

[Model roles](../agents/model-roles.md#fresh-context-and-handoff) states what a
written handback carries. Meet that list before you hand anything back: the
exact HEAD and the dirty diff or a manifest, the command you ran, the failing
case or refusal code, expected against actual, the relevant logs with secrets
removed, where you put the evidence, and what you are still unsure of. A report
missing the head is a report about a tree nobody can reconstruct.

Secrets live in `.local/`, which is gitignored for that reason: `db.env`,
`auth.env`, `synthetic-users.json`, `synthetic-agents.json` and `gate.env`. A log pasted into a report goes through the same filter: no generated
password, no GoTrue secret, no signing key.

## A note on the dev server

`pnpm web:up` runs Vite's dev server, and a dev server serves files, not just
the application. Every path under the workspace root is reachable through its
`/@fs/` prefix, which is how a source import of `packages/ui` works at all.

On 23 September a probe of the running server asked for
`/@fs/<worktree>/.local/db.env` and got 200 with the file's real content, and
the same for `.local/auth.env` and `.local/synthetic-users.json`: the
generated database password, the GoTrue secret and every synthetic login,
readable by anything that could reach the port. The server binds to
`127.0.0.1`, so that was one machine's own loopback rather than the network,
which is why this is a gap rather than an incident.

`apps/web/vite.config.ts` now sets `server.fs.deny` over `**/.local/**` and
`**/*.local`, alongside Vite's own defaults, which that setting replaces. The
three paths answer 403; a source import such as
`/@fs/<worktree>/apps/web/src/main.tsx` still answers 200, and so does
`packages/ui/src/index.ts`.

Two things this does not do. It is a dev server, and a dev server is for one
person's machine on loopback: do not put one on an address other people can
reach, whatever it denies. And it constrains this server only -- the API on
its own port and anything else the start sequence runs are not covered by it.

## Limitations

The slice is honest about being a slice.

- **Not deployed, not released.** No installer, no image, no published package,
  no hosted service. The L1-L6 sequence is not complete.
- **There is no dark theme.** The application does not answer
  `prefers-color-scheme`, so a person who has chosen dark gets the light build.
  This is the largest visual gap and the one a person would call a defect.
- **Three smaller width gaps**, recorded rather than closed, along with the
  board columns, facets, agent surfaces and subtasks that this build does not
  store or draw: [WEB.md, "Known gaps against the pinned
  mockup"](WEB.md#known-gaps-against-the-pinned-mockup). Comments are stored and
  drawn; what is missing there is the mockup's tabbed Internal / Client / All
  activity conversation, which this build draws as one list with each row's
  audience on it.
- **An external party cannot be invited from the app.** The product reads a
  real external party's shared record ([AUTHORITY.md, "The external
  party"](AUTHORITY.md#the-external-party-r4)), but no route issues a share.
  The seed enrols one external party. It shares a task with that party only
  when it is rerun with `LOCAL_SEED_SHARE_TASK` naming the task.
- **Reviews are recorded outside this repository.** The slice's review record
  is held with the build run's evidence, not in the tree, and the review of the
  final integrated head is still owed. A green `pnpm check` is not a review and
  does not stand in for one.
- **Local checks prove local behaviour only.** Nothing here is evidence about a
  hosted deployment, hosted enforcement, or another machine.
