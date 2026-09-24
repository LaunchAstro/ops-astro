# The web application, locally

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

The staff application: sign in, the projects board, one task page. It is a Vite
dev server on `127.0.0.1:5190` that proxies `/api` to the API on
`127.0.0.1:8790`, so the browser only ever makes same-origin requests.
`OperationsClient` takes an `origin`, empty for same-origin, and posts under
`PREFIX.person` from `commands/surface.ts`. `App` takes it as `apiOrigin`, which
`main.tsx` reads from `VITE_API_ORIGIN` (unset in local runs).

## Start it

```
export PATH=<toolchain>/node-v24.21.0-darwin-arm64/bin:$PATH
pnpm install
scripts/local/web-up.sh
```

`WEB_PORT`, `API_ORIGIN` and `GOTRUE_URL` override the three addresses. The port
is strict: if 5190 is taken the script fails rather than moving, because
evidence with the wrong address in it is worse than no evidence.

This script starts none of the database, the identity service or the API.
Start those first ([README.md](README.md#start-it)). Until they are up the board
reports the API as unavailable, which is the intended reading.

## Sign in

Email and password go to GoTrue's own `/token?grant_type=password`. The
application never mints or inspects a token. The API verifies the signature.
The business selector (`alpha` or `bravo`) chooses the `/api/b/<key>` prefix. It
is a routing choice, not a claim, so picking `bravo` with an alpha-only account
gets `AUTH_NO_MEMBERSHIP` rather than access to bravo.

The synthetic credentials live in the gitignored `.local/synthetic-users.json`,
which `auth:seed` writes.

### When the session ends

A local access token lives for one hour. The API refuses a bearer it will not
act on with HTTP 401 and one of two codes (`docs/local/API.md`). A missing, a
forged, an unsigned and a subject-less bearer all answer `AUTH_UNKNOWN_LOGIN`,
because telling them apart tells an unauthenticated caller which guess was
closer. A bearer whose signature verifies against this deployment's own secret
and whose `exp` has passed answers `AUTH_SESSION_EXPIRED` instead. That one is
not a guess. Whoever sent it held a credential this server issued a session
for, so telling them the session ran out gives away nothing they could not
already prove, and it sends them to sign in again.

To the screen, both codes mean the session has ended. The client
(`operations/client.ts`) is the one place that recognises them, for a read and a
mutation alike. It raises `onSessionEnded` with the refusal the server sent. On
that signal the application drops the session, remembers the address the person
was on, and goes to `/sign-in`. There a notice (`role="status"`,
`data-reason="session-ended"`) says the session has ended, quotes the server's
own code so the person can repeat it, and says that anything unsaved was not
saved. Signing in again returns to the remembered address, so a task page stays
a task page. With nothing remembered it goes to `/projects/`.

**The refusal belongs to the session that made the request.** A client keeps the
bearer it was built with, so a call can be answered after that bearer has
stopped being anybody's session. Two reads leave together, the first 401 sends
the person to sign-in, they sign in, and the second answer arrives afterwards.
The notification carries the session the client was built with, and the
application clears and navigates only if that session is still the one in hand.
A late refusal of an old token cannot sign a person out of the session that
replaced it.

**An address is remembered with the business it meant.** A task key is
business-local. The business is the `/api/b/<key>` prefix, not part of
`/task/<key>`, so the same address names a different record in each business.
The interruption keeps the business key beside the address. Sign-in then offers
that business rather than the first in the list, and reopens the held address
only when the new session is in the same business. Choosing another business on
purpose is not refused. It goes to that business's board with a notice (`role="status"`, `data-notice="other-business"`) naming the business the
held address belonged to. The token is never kept; the business key is the word
in the URL prefix and the word in the top bar.

The address and its business are kept in `sessionStorage` under
`ops-astro.return-to`, beside the session itself and under the same rule: never
`localStorage`, gone when the tab is, and spent the moment it is used. Signing
out clears it too, so an ordinary sign-in is never redirected by an interruption
somebody already answered.

All browser storage is read and written through `jsonSlot` in
`apps/web/src/session/token.ts`. The screens get their storage from
`tabStorage()` in the same file. A tab with blocked site data draws the screens
with nothing remembered rather than failing.

Nothing in the web calls for a refresh token, inspects a token or decodes one.
The server decides the hour, and the browser finds out only by being refused. `tests/surfaces/session-ended.test.tsx` holds the three rules, and
SX1 to SX3 in `tests/browser/cases-session-expiry.mjs` show them in a real
browser.

## Addresses

| Address      | What it draws                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `/sign-in`   | Credentials and the business selector                                                            |
| `/projects/` | `task.board` for the unboarded tasks (`board: null`), and the create form                        |
| `/task/:key` | `task.read`: state buttons, the assignee select, title and due date, comments, history, revision |
| `/settings`  | The two operation-classified business settings, from `settings.read` and `session.capabilities`  |

`/task/:key` is a real address. A hard reload lands on it because the dev server
falls back to `index.html`, and everything on the page is reread from the API.

The route registry is the router. `SCREENS` in `apps/web/src/screen-registry.tsx`
looks each screen up by route id and is keyed by `AuthenticatedRouteId`, so an
authenticated route added to `apps/web/src/routes.ts` without a screen fails
the typecheck. The screens build addresses with `pathTo` in `routes.ts` from a
route id and its parameters, never as literal strings. `ROUTES` is keyed by
route id, and each route's parameters are typed from its path: `pathTo` takes
`{ key }` for `agency:task-detail` and nothing for the others, and a missing
parameter is a type error. The sign-in gate is `gateOf` in `routes.ts`. The
tab's `storage` reaches `App` as a prop from `main.tsx`.

The task page is `TaskDetailScreen` and `Loaded` in
`apps/web/src/screens/TaskDetail.tsx`. The parts it draws live beside it in
`apps/web/src/screens/task/`: `Comments.tsx`, `DetailsForm.tsx`,
`Lifecycle.tsx` (the state buttons and the assignee select) and `History.tsx`.

`/task/:key` for an external party (R4) draws `SharedTaskDetail` from
`task.read`'s `sharedTask` answer: the shared fields under their server keys and
the client comments, with no controls and no other read. The `sharedTask` key
picks the view, never the role (`TaskDetailScreen` in
`apps/web/src/screens/TaskDetail.tsx`). A revoked share draws the same denied
state as a revoked grant.

### How a write settles

Every write on the task page, in the proposals view (`views/proposals.tsx`) and
on the board goes through `useCommand` in `apps/web/src/records/use-command.ts`.
It sorts the answer once into one of five kinds:

- `ok`: stored. The settlement carries the server's answer (`Settlement<T>`),
  so a caller reads a command's echo from it rather than capturing the result
  by hand.
- `stale`: `VERSION_STALE`. Somebody else moved the record on first.
- `closed`: `SCOPE_NOT_GRANTED`. The refusal is about the reader, so asking
  again would only be refused again.
- `failed`: any other refusal. Nothing was stored.
- `unknown`: no answer arrived, so the write may or may not have been stored.

The refusal text is the server's, by code (`describeRefusal`). A caller adds
only what happens next, such as clearing the comment box or rereading the task.
Beside `busy` and `failure` the hook returns `closed` (sticky once
`SCOPE_NOT_GRANTED` answers, until the screen unmounts), `locked` (`busy ||
closed`), `conflict` (the last `stale` refusal) and `because` (the last
failure's text).

The settings screen's writes go through `useCommand` too. `use-settings.ts`
keeps only what settings does with each kind, and its memory of the last
confirmed write is in `confirmed.ts`.

## Comments on a task

`task.read` has carried the task's comments since L3 (`docs/local/API.md`).
`/task/:key` draws them through `Comments` (`screens/task/Comments.tsx`). Each
one is an `article[data-comment-id]` carrying `data-audience`, with the audience
printed in words above the body. Who may read a comment is the one thing the
person writing the next comment needs to know, and a colour cannot say it. `InternalTaskComment` (`operations/shapes.ts`) is the internal
reader's comment, with every field present. `TaskComment` is optional past `id`,
because the shared projection sends only the fields the catalogue marks shared.

The form is `form#task-comment`: a required `textarea#comment-body`, a
`select#comment-audience` (internal or client) and a `select#comment-kind`, with
`button[data-comment="post"]`. Posting goes through `task.comment` with the
revision the page holds. That command writes a record beside the task and
leaves the task's own revision alone, so nothing else on the page goes stale
because somebody said something.

**The list is the server's.** After a post the screen rereads `task.read`; it
never appends the comment it just sent. A screen that appended would be drawing
a row that may never have been stored, which is B7's failure in another
form.

**A refusal is quoted and the box is closed.** There is no grant read anywhere
in this build, so the screen cannot know whether a person holds `comment` before
it asks. It asks once. On `SCOPE_NOT_GRANTED` it draws the server's own code in
`p[data-comment="refusal"]`, disables the box and the button, and says why. A
second press reaches nothing; C2 counts the requests rather than trusting the
`disabled` attribute. Anything else the server refuses (an empty body, an
audience it does not have) is reported and the box stays open, because that is
something the person can fix.

Keyboard: the textarea, the two selects and the button are ordinary controls in
document order after the details form, each with a `label` bound by `htmlFor`.
Tabbing from the box reaches `comment-body -> comment-audience -> comment-kind
-> post` and nothing is reachable only by mouse. Photographed at 1480, 900 and
390 on 2026-09-23 with no horizontal overflow at any of the three. The
captures are held with the build run's evidence, not in the tree. The
dark-theme gap recorded below is this page's too: there is no dark build to
photograph.

## Proposals on a task

The task page draws every proposal on the task under the comments, out of the
`proposals` projection `task.read` already carries (`docs/local/API.md`,
"Proposal projection"). There is no separate read, on purpose. The
`versionId` an approve control sends is the version whose evidence and digest are
drawn beside it, from one answer, so the page cannot offer a decision on
something it never displayed.

For each lineage it draws the lineage's state, then its versions newest first. Each
version shows the purpose, the ceiling as money with the currency the proposal
named, the payload digest, the payload, and the evidence pack with its renderer
and its digest. After the versions come the gate's state, round and expiry, then
the decision chain as stored rows with their sequence, decision, round, decider,
instant and stored hash, then the reservation with what it held, what the work
reported spending, and its lease and attempt.

**Nothing on this screen is recomputed.** The evidence body and the payload are
printed as they were stored, because evidence that changed between the decision
and the display is the one thing a gate cannot survive. The hashes are the stored
values. A recomputed hash drawn as though it were the stored one would make a
tampered link look sound. And whether a gate has expired is the server's
`expired` field, never a comparison against the browser's clock, so a laptop a
few minutes out cannot offer a decision the server is certain to refuse or hide
one it would have accepted.

There are three states and no fourth. An empty projection says nobody has proposed
anything (`[data-proposals="none"]`). A task read that carried no `proposals` key
at all says so instead (`[data-proposals="not-carried"]`). An absent projection
and an empty one are different facts, and defaulting one to the other would
print "no proposals" over a projection nothing consulted. A read the server
denied never reaches this section, because `RecordState` draws the denial for
the whole task. There is no path from any of the three to sample data.

**The propose form** (`form#task-propose`) sends `task.propose` with the task's
own `recordId` and the revision the page is holding, the purpose, the ceiling and
the currency. The amount is typed in dollars and converted to the server's minor
units once, in the client, because three places that each convert are three
places that can disagree. A refusal is quoted with the server's own code in
`[data-propose="refusal"]`. On success the form clears and the task is read again,
so the new version appears because the server has it and not because the form
drew what it sent.

**The decision controls** (`[data-decide="approve"]` and
`[data-decide="reject"]`) are drawn only on the head version, and each carries
the `data-version-id` and `data-gate-id` it will send. They are absent, with the
reason in `[data-decide="closed"]`, when the gate is not pending, when the server
says it has expired, and after a refusal about the reader's own authority. The
screen quotes a refused decision verbatim in `[data-decide="refusal"]` and
follows it with a fresh `task.read`. A refusal like `VERSION_SUPERSEDED` or
`GATE_ALREADY_DECIDED` is the server saying this page has stopped describing the
record, and the answer is to read it again, not to retry. `TaskDetail.tsx` holds
the refusal text above the read state, because the reread unmounts everything
under it. A message that vanished with the thing it explained would leave the
screen changing for no stated reason.

What this screen does not read back, and cannot:

- **This screen does not consult the capability read**, so it cannot know
  whether a person may decide before they ask. `session.capabilities` exists
  ([API.md](API.md#reads)), but only `/settings` reads it. A member without
  `task:decide` presses Approve once, reads the server's `SCOPE_NOT_GRANTED`,
  and the controls close. The answer is honest, but the first press of a
  control a person may not use is always a refused request. The same gap
  applies to comments.
- **Only the seeded admin holds `task:decide`.** The seed gives its admin
  `task:decide` beside six other `task` actions, `person:read`,
  `settings:manage` and `settings:read` (`GRANTS_BY_ROLE` in
  `scripts/local-seed.mjs`). A member holds neither `decide` nor `manage`, so
  the admin in each business can approve through the product and a member
  cannot. The browser case still
  issues its own `task:decide` grant through the authority path and revokes it
  afterwards, so its result does not depend on the seed.
- Rejecting sends `decision: 'reject'` through the same control and the same
  exact-version comparison. The change-round behaviour behind a rejection is the
  runtime's and this screen does not model it.
- **A form-driven `VERSION_SUPERSEDED` is unreachable**, and this is the
  contract rather than a gap in the screen. The form sends no `lineageId`, so a
  second proposal opens a new lineage instead of adding a version to the live one
  (`core-runtime/src/propose.ts`). `decide` checks the gate's state before the
  version it carries, so when a page has gone stale its Approve lands on a
  superseded gate and the honest answer is `GATE_ALREADY_DECIDED`. The screen
  quotes whichever it gets and rereads either way. `cases-proposals.mjs` proves
  `VERSION_SUPERSEDED` through the client, where a `lineageId` can be named, and
  the screen's own path separately.
- The agent's own path has no screen. Pickup, handback and the queue are stored
  and projected, and the web does not draw them yet.

## The settings screen

`/settings` draws the two settings the model classifies `operation`:
`four_eyes_threshold` and `client_sign_off_required`. Each is written through
the command that owns it, `settings.set_four_eyes_threshold` or
`settings.set_client_sign_off`, with an `operationId`, and with an
`expectedRevision` when the read carried a revision for that row.

**The values are the server's.** The screen asks `settings.read` on open and
after every write, so the number beside a setting is the business's and not this
browser's memory of its own write. Each row draws its value and its `updatedAt` in
`p[data-settings="four-eyes-value"]` and `p[data-settings="four-eyes-updated"]`
(and the same pair for `sign-off`). The read goes through `useRead`, so the
generation counter and the denial floor apply to it as to any other read.

The screen draws four states, and none of them shows a value: `loading`, `denied`
with the refusal verbatim, `unavailable` with the absence stated as an
absence, and `empty` for a business holding no rows. The state is on
`div[data-settings="read"]` as `data-outcome`.

The "Last confirmed by this browser" line (`p[data-settings="four-eyes-known"]`
and `sign-off-known`) and the not-readable banner
(`p[data-settings="not-readable"]`) appear only while `settings.read` is
unavailable: no answer, an answer that is not JSON, or a non-2xx without a
refusal, which is what a missing route gives. They never appear when the read is
refused. `SCOPE_NOT_GRANTED` is the server declining to tell this reader the
value, and nothing stands in for it. The refusal also removes the cached value
and marks the session. After that, a later unavailable read, in the same screen
or after a remount, still shows "not known", and a write confirmed before the
next authorised read is not cached. An authorised read lifts the mark. The cached
value lives in `sessionStorage` under `ops-astro.settings.<business>`, tagged
with the session that wrote it, so another session in the same tab sees "not
known". `SessionStore.clear` in `apps/web/src/session/token.ts` removes it at
sign-out and when a 401 refusal ends the session. A save answered after sign-out
caches nothing. It notes the session generation (`sessionGeneration`) when
pressed and writes only if no session has ended since. A confirmed save is
written to the tab's storage when the server answers, whether or not the screen
is still mounted, and never from a React state updater. If a refused read's mark
is written in the same moment, the mark wins, so a later unavailable read in
that session draws nothing.
`tests/surfaces/settings-denied-fallback.test.tsx` and
`tests/surfaces/settings-late-save.test.tsx` hold both. The server's value and
the cached one are never on the page together, and the screen never draws the
shipped default.

**`session.capabilities` opens the controls.** `settings:manage` in the grants
opens them. Its absence closes them and names the scope in
`p[data-settings="capabilities-because"]`, sending nothing. A refused
capability read closes them too, because a screen that cannot find out what
somebody may do does not guess in their favour. An _unavailable_ capability
read leaves them open. Nobody decided anything, and closing on an absence would
make the screen unusable against a build that has not landed the read.
A `SCOPE_NOT_GRANTED` on a write closes them whatever the capabilities said,
since a grant can be revoked between the read and the press. The state is on
`div[data-settings="capabilities"]` as `data-outcome`.

**`VERSION_STALE` is a conflict, not an error.** The screen rereads, draws the
server's value beside the person's draft in `div[data-settings="conflict"]`
with `conflict-server` and `conflict-draft`, quotes the refusal, and waits.
The overwrite takes a second explicit press on
`button[data-settings="confirm-four-eyes"]` and goes out against the reread
revision. Until the reread has answered, the controls are closed. The second
press writes over only what the reread showed. If the reread is refused or
unavailable, the press writes nothing (`writeOver`,
`screens/settings/use-settings.ts`). The screen never retries by itself.

Keyboard path: `settings-four-eyes -> settings-four-eyes-off ->
save-four-eyes -> settings-sign-off -> save-sign-off`. Measured at 1480, 900
and 390 with 0px of horizontal overflow at each.

Not built: the read carries `conversation_window_days` and
`retention_window_days` and nothing in the web has a home for them.

## What the five read states mean

`views/record-state.tsx` draws each one differently and never substitutes data:

- `loading`: the read is in flight.
- `ready`: rows arrived.
- `empty`: you are permitted to see the collection and it has no rows. Not a
  failure, and never drawn as one.
- `denied`: the server refused. Its code is shown verbatim, because a refusal
  a person cannot quote is a refusal they cannot get help with.
- `unavailable`: the API did not answer. Nothing has been decided about your
  access.

Before anything draws it, a read is a `ReadState` (`data/authorised-read.ts`), a
union on `outcome` with one member per state, so a reader that narrows on
`outcome` gets the non-null field without a check. `loading.previous` is the
last answer, kept while a reload is in flight. It is null on the first read
and after a denial or an outage, because those already dropped it.
`RecordState` still draws the loading state rather than that value.

There is no path from a failed read to sample data anywhere in this application.

## Tests

```
pnpm exec vitest run tests/surfaces
```

These suites have no config of their own. The root Vitest config collects
`tests/**/*.test.tsx` alongside `tests/**/*.test.ts`, so `pnpm test` picks them
up with everything else. The command above runs this lane's suites on their
own.

The `.ts` suites need no browser: route derivation and the envelope against a
stubbed `fetch`, and the generation/denial ordering in `authorised-read.ts`. The
`.tsx` ones mount into jsdom, declared per file with a
`// @vitest-environment jsdom` docblock rather than in a config, so a file says
for itself what it needs and a new one needs nothing added anywhere else.

None of them touches the API, and none discharges a browser acceptance case.
They prove the wiring; B1 to B7 prove the product.

## The browser checklist, in one command

```
pnpm verify:browser
```

That runs `tests/browser/slice-acceptance.mjs` against the stack already
serving on 5190/8790, writes every case into `RESULTS.md` with a screenshot
each, and exits non-zero if any case failed. It is the whole checklist in one
place: B1 to B7, N1 to N7 including the real N6 revocation harness, and every
other case group in the table below.

The screenshots and `RESULTS.md` go to the directory `SHOT_DIR` names, which
defaults to `.local/evidence/browser` inside the repository and is created if it
is not there. The default is gitignored and belongs to the clone rather than to
one machine, so anybody who has it can run the checklist and read its table
without first recreating somebody else's folder. A coordinator's run sets
`SHOT_DIR` to gather the evidence with the rest of the round's.
`node tests/browser/keyboard-and-widths.mjs` takes the same default and the same
override. `DOCKER_BIN` names the `docker` binary the database cases call, and
defaults to `/usr/local/bin/docker`, which is where a machine that does not put
it on the agent's `PATH` still has it.

It is evidence, not a check, and it is not cheap. B7 kills the API under a
mounted page, and B6 then restarts the API and stops and starts a Postgres
container, keeping its volume (`cases-b6-b7.mjs`). Before it stops anything B6
makes two tasks of its own, one with a pending gate and one approved and picked
up by the alpha agent so it has a lease and an attempt, and afterwards the alpha
agent hands that lease back to the restarted API. The settings cases issue a
live `settings:manage` grant of their own through `issueGrant`, revoke it in a
`finally` and put back the threshold they wrote (`cases-settings.mjs`). The
proposal cases do the same with `task:decide`, so their result does not depend
on the seed (`cases-proposals.mjs`), and N6 revokes a grant through
`revokeGrant` for real. Each of those restores what it changed, but it changes
it, so run this when you want the table and not on every edit.

The run is made of one module per case group, so a group can be read or
changed without reading the rest:

| File                       | Cases                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness.mjs`              | sign-in, the in-page client, screenshots, the results table                                                                                                |
| `cases-b.mjs`              | B1 to B5, the journey and the reload                                                                                                                       |
| `cases-n3-n5.mjs`          | protected fields, system fields, replay and revision                                                                                                       |
| `cases-n6-n7.mjs`          | N7 input tampering, N6 revocation (via `n6-revocation.mjs`)                                                                                                |
| `cases-n1-n2.mjs`          | another business, and a member with no grant                                                                                                               |
| `cases-create-retry.mjs`   | R1, retrying a create whose answer was lost                                                                                                                |
| `cases-task-drafts.mjs`    | D1, the explicit Save or Discard of an unsaved detail                                                                                                      |
| `cases-session-expiry.mjs` | SX1 to SX3, an ended session reaching sign-in and returning to the same task                                                                               |
| `cases-b6-b7.mjs`          | the API down, the process and database restart, and a pending gate, a lease and an attempt across it                                                       |
| `cases-comments.mjs`       | C1 a comment posted and reloaded, C2 a member refused once                                                                                                 |
| `cases-settings.mjs`       | S1 the screen's provenance, S2 a member stopped, S3 the value comes from the read, S4 closed by capability with no request, S5 a stale write as a conflict |
| `capabilities-denied.mjs`  | CD1 a member's capability read drawn, CD2 a member with no grant drawn as denied with no write sent                                                        |
| `cases-proposals.mjs`      | P1 a proposal drawn with its evidence, P2 an exact-version approval, P3 a stale version refused                                                            |
| `i10-open-page.mjs`        | I10, an open task page whose record grant is revoked through `grant.revoke`                                                                                |
| `r4-shared-page.mjs`       | R4, an external party's shared task page, revoked through `grant.revoke` while open                                                                        |
| `surface-final.mjs`        | D03 and D05 through the page's own client, and R4X the external party's reads                                                                              |

### What B6 restarts

B6 restarts `ops-astro-local-pg` with the `ops-astro-local-pgdata` volume by
default, which is the registered run. A stack of your own names its pair, and
B6 restarts the API on `API_URL`'s port:

```
B6_PG_CONTAINER=ops-astro-webrs-pg B6_PG_VOLUME=ops-astro-webrs-pgdata \
WEB_URL=http://127.0.0.1:5197 API_URL=http://127.0.0.1:8797 \
  node tests/browser/slice-acceptance.mjs
```

The live pair goes through `scripts/local/db-down.sh` and `db-up.sh`, as it
always has. B6 stops and starts a named container with `docker` directly,
because those two scripts only know the live name. `restartTargetOf` in
`harness.mjs` refuses `ops-astro-datafix-pg`, its volume, any `supabase_*` name,
and a container named without its volume. The refusal happens when the module
loads, so the run exits before any case has run.

B6 records four rows. The first is the task from B1 to B5, read again after the
restart. The second is the pending gate: lineage, version and gate ids, the gate
still `pending`, not expired and with no decision. The third is the reservation,
lease and attempt. The screen and `task.read` must each give the same answer as
before the restart. The fourth is the hand-back. A run that skipped it would
leave the agent's delegation live, and the next run's pickup would be refused
`DELEGATION_ALREADY_LIVE`. The screenshots are `B6-runtime-before-*.png` and
`B6-runtime-after-*.png`.

`cases-b.mjs` assigns the task to noah's person, chosen by id rather than by
label. It finds that person through the login whose subject is noah's in
`.local/synthetic-users.json`, which is the same link the seed makes. The seed
takes the display name from that file (`Noah Patel`), and the live database
still has the older `Noah Alpha`. B2 passes on either, because the name is only
quoted in its row.

S5 reads the conflict block only once `conflict-server` shows `999` and
`conflict-draft` shows `1200`. The block draws as soon as the refusal arrives
and fills in the server's value only after its reread lands. A read taken
before that finds `VERSION_STALE` and neither number.

`n6-revocation.mjs` and `keyboard-and-widths.mjs` also run on their own
(`node tests/browser/<file>`).

I10 (`i10-open-page.mjs`) differs from N6 in how it revokes. N6 calls the
internal `revokeGrant`. I10 has a grant manager call `grant.revoke` on the
running API while a member's `/task/` page is open, and the member's only
authority is one record grant. It records three rows: the next fetch is denied,
an authorised response held back from before the revocation does not restore
the task, and a later read is still denied. It runs after P and before B6/B7
(`casesI10OpenPage` follows `casesProposals` in `slice-acceptance.mjs`),
because P issues and revokes a grant and B6/B7 stop the API. The last recorded `pnpm verify:browser` run with these rows in it
was at `6f15252`. None is recorded at this head.

The R4 rows (`r4-shared-page.mjs`) follow I10's order on an external party's
shared page: the shared view opens, the next fetch after `grant.revoke` is
denied, an authorised response held from before cannot restore it, and a later
read stays denied. They run after I10 (`casesR4SharedPage` in
`slice-acceptance.mjs`). The revoked
read answers 403 `AUTH_NO_MEMBERSHIP`, because with its only share gone the
party has no standing left to resolve (`resolveLogin` and `standsOnShares` in
`packages/core-records/src/identity/login-resolution.ts`). An unshared sibling
task or the board answers `NOT_FOUND` while the share is live (the row's
`outsiderNotFound` in `READ_CATALOGUE`,
`packages/core-records/src/reads/catalogue.ts`, checked by `serveRead` in
`reads/dispatch.ts`). Neither leaks content.

`surface-final.mjs` runs after R4 (`casesSurfaceFinal` in
`slice-acceptance.mjs`). D03:
`task.update` naming `client`, `client_visible` or `delegate` is refused
`TRANSITION_PROTECTED` and the stored row is unchanged. D05: a classified
`preset.plan` is accepted and one with an unclassified field is refused
`PRESET_FIELD_UNCLASSIFIED`, neither adding a `field_defs` row. R4X: the
external party reads its shared task, is refused the sibling task and the
board, and is refused the shared task after `grant.revoke`. Every call goes
through `operations/client.ts` inside the page. Both files also run on their own.

`pnpm verify:browser` exits zero only when every row passed. `writeResults`
returns the rows that did not pass, whether failed, pending or unrun, so a run
that stopped early, or that recorded a required case as pending a sibling lane,
cannot leave the command looking like an accepted one. The `pending` and `unrun`
labels stay in the table, because they make a partial run readable; they no
longer buy a zero exit. The last recorded `verify:browser` result is 88 of 88 at
`6f15252`. None is recorded at any later head, `1ddb286` included, so at this
head the browser checklist is unrun
([PROOFS.md](PROOFS.md#current-counts-and-what-they-are)).

### Cases address controls by attribute, not by text

Two buttons on `/task/:key` read **Save changes**: the edit form's own
`form#task-fields button[type="submit"]`, drawn by `DetailsForm` in
`apps/web/src/screens/task/DetailsForm.tsx`, and the unsaved-changes bar's
`button[data-draft-resolve="save"]`, drawn by `Loaded` in
`apps/web/src/screens/TaskDetail.tsx`. Both submit the same form. The bar's
button is outside it and reaches it through `form="task-fields"`, so whichever
one is pressed, a cleared title is refused. A case that asks for the button by
its name matches both and fails on the ambiguity, so B4 presses the form's
submit, the honest control for a case that edits the fields and then saves
them. The three state buttons (`Lifecycle` in `screens/task/Lifecycle.tsx`)
are pressed through `button[data-lifecycle="start"|"complete"|"reopen"]` for
the same reason. A second control that happens to share a word cannot make an
attribute the screen owns ambiguous.

## Known gaps against the pinned mockup

Recorded rather than closed. The mockup is the visual source; these are the
places this build does not yet reach it.

- The board draws nine pinned columns; this build stores five of them. Rank,
  client, stage, estimate and actual draw the ported "not set" dash.
- No facet menu, presets, undo/redo, typeahead or column drag-resize.
- No Agent panel, gate or run surfaces, and no dock tab for them. The records
  behind them are stored and read: `task.read` carries every proposal on the
  task with its gate's state and expiry (`docs/local/API.md`'s "Proposal
  projection", served by `packages/core-records/src/reads/proposals.ts`). So this
  is the web not drawing them yet and not the database failing to hold them, and
  the panel registry stays empty until there is a screen for a tab to open.
- Subtasks are not built. Comments are, and the task page draws them. The
  mockup's tabbed Internal / Client / All activity conversation is not built:
  the comments are one list with each row's audience on it, and history stays
  its own section below.
- **`system` is not offered as a comment kind.** The API takes `note`, `client`
  and `system`; the form offers the first two. A system comment is one the
  product writes about itself, and a box letting a person post one by hand makes
  every system note on a task unreliable evidence of anything.
- **The exact-revision path is proved only where the read sends a revision.**
  The screen writes `expectedRevision` for a row whose `settings.read` answer
  carried `revision`, and not otherwise. `business_settings` has the column
  from migration `0020`, and on this head `settings.read` projects it on every
  row (`readSettings` in `packages/core-records/src/reads/settings.ts`). A
  running API built from an older head does not send it. Where it does not, the
  path and its `VERSION_STALE` conflict are held by mounted cases alone, and
  browser row S5 records `pending` with the reason. Where it does, S5 runs with
  no edit. Which of the two happened is in S5's own row, not in this document.
- An unsaved edit does not survive re-login. When the session ends the draft
  goes with the screen, and the notice on `/sign-in` says so rather than
  implying it was kept. Preserving a draft across a sign-in would mean holding
  edited record content for an unauthenticated tab, which is a larger decision
  than this slice makes.
- Signing in to a different business than the one that was interrupted does not
  reopen the held address. A task key is business-local, so the same
  `/task/<key>` names a different record in each business; the application goes
  to the new business's board and says which business the held address belonged
  to. Offering to switch back, or carrying more than one interruption, is not
  built. The interruption keeps the business key, which is the word in the URL
  prefix, and never the token.
- Fonts and icons are not fetched. The redistribution question (#32) is open, so
  the families are a stack with real fallbacks and the brand is its own words.
- Layouts are written for 1480, 900 and 390. Photographed at all three, light
  and dark, on 2026-09-23 with `node tests/browser/keyboard-and-widths.mjs`,
  which writes `width-<w>-<theme>-<page>.png` into `SHOT_DIR`; that run's
  captures are held with the build run's evidence. What the twelve captures show:
  - **There is no dark theme.** Eleven of the twelve light/dark pairs are
    byte-identical; the app does not answer `prefers-color-scheme`, so a person
    who has chosen dark gets the light build. The twelfth pair differs only
    because a task was created between the two captures. This is the largest
    gap of the four and the only one a person would call a defect.
  - No horizontal overflow at any of the three widths, on either page.
  - At 390 the sidebar is gone, and with it the only navigation apart from the
    breadcrumb. A person who lands on a task deep-linked has `Projects` in the
    crumb and nothing else.
  - At 390 the task page's assignee section can still be drawing
    `Loading the people…` after the record itself is on screen: two reads, two
    arrival times, and the slower one is a block of text in the middle of the
    form rather than a field-shaped placeholder.

  Recorded, not fixed.
