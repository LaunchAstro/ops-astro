# The local slice

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

How to start the task slice on your own machine, how to check it, and what it
does not do. The three companion files describe the parts:
[the database](DATA.md), [the API](API.md), [the web application](WEB.md).

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

Two businesses, keys `alpha` and `bravo`. The business selector on the sign-in
page chooses the `/api/b/<key>` route prefix; it is a routing choice, not a
claim, and the API resolves who you are and what you may see server-side.
[DATA.md](DATA.md) names which identities carry which negative case.

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
corepack pnpm verify:browser
```

Drives the browser acceptance cases through Playwright against the running
application, so start the database, the identity service, the API and the web
server first. Two further harnesses are not in that command and run on their
own: `node tests/browser/n6-revocation.mjs` (a grant revoked underneath a live
session) and `node tests/browser/keyboard-and-widths.mjs` (keyboard paths, and
the width captures the gaps below are recorded from).

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

## Limitations

The slice is honest about being a slice.

- **Not deployed, not released.** No installer, no image, no published package,
  no hosted service. The L1-L6 sequence is not complete.
- **There is no dark theme.** The application does not answer
  `prefers-color-scheme`, so a person who has chosen dark gets the light build.
  This is the largest visual gap and the one a person would call a defect.
- **Three smaller width gaps**, recorded rather than closed, along with the
  board columns, facets, agent surfaces, comments and subtasks that this build
  does not store or draw: [WEB.md, "Known gaps against the pinned
  mockup"](WEB.md#known-gaps-against-the-pinned-mockup).
- **Reviews are recorded outside this repository.** The slice's review record
  is held with the build run's evidence, not in the tree, and the review of the
  final integrated head is still owed. A green `pnpm check` is not a review and
  does not stand in for one.
- **Local checks prove local behaviour only.** Nothing here is evidence about a
  hosted deployment, hosted enforcement, or another machine.
