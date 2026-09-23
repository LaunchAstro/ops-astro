# The web application, locally

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

The staff application: sign in, the projects board, one task page. It is a Vite
dev server on `127.0.0.1:5190` that proxies `/api` to the API on
`127.0.0.1:8790`, so the browser only ever makes same-origin requests.

## Start it

```
export PATH=<toolchain>/node-v24.21.0-darwin-arm64/bin:$PATH
pnpm install
scripts/local/web-up.sh
```

`WEB_PORT`, `API_ORIGIN` and `GOTRUE_URL` override the three addresses. The port
is strict: if 5190 is taken the script fails rather than moving, because
evidence with the wrong address in it is worse than no evidence.

The database, the identity service and the API belong to the other two lanes and
this script starts none of them. Start those first; the board will report the
API as unavailable until they are up, which is the intended reading.

## Sign in

Email and password go to GoTrue's own `/token?grant_type=password`. The
application never mints or inspects a token — the API verifies the signature.
The business selector (`alpha` or `bravo`) chooses the `/api/b/<key>` prefix; it
is a routing choice and not a claim, so picking `bravo` with an alpha-only
account gets `AUTH_NO_MEMBERSHIP` rather than access to bravo.

The synthetic credentials live in `.local/synthetic-users.json`, which the API
lane's auth seed writes and which is gitignored.

### When the session ends

A local access token lives for one hour, and the API answers a missing, an
expired and an unverifiable bearer identically: HTTP 401 with
`AUTH_UNKNOWN_LOGIN` (`docs/local/API.md`). So the application does not say
"expired" — it cannot know that — and it does not leave the person on a refusal
they cannot act on either.

The client is the one place that recognises it (`operations/client.ts`), for a
read and a mutation alike. When it arrives while a session is held, the
application drops the session, remembers the address the person was on, and goes
to `/sign-in`, where a notice (`role="status"`,
`data-reason="session-ended"`) says the session has ended, quotes
`AUTH_UNKNOWN_LOGIN` as the server's own word, and says that anything unsaved
was not saved. Signing in again returns to the remembered address — a task page
stays a task page — and with nothing remembered it goes to `/projects/`.

**The refusal belongs to the session that made the request.** A client keeps the
bearer it was built with, so a call can be answered after that bearer has
stopped being anybody's session: two reads leave together, the first 401 sends
the person to sign-in, they sign in, and the second arrives afterwards. The
session the client was built with comes back with the notification and the whole
clear-and-navigate action is gated on it still being the one in hand, so a late
refusal of an old token cannot sign a person out of the session that replaced
it.

**An address is remembered with the business it meant.** A task key is
business-local — the business is the `/api/b/<key>` prefix, not part of
`/task/<key>` — so the same address names a different record in each business.
The interruption keeps the business key beside the address, sign-in comes back
offering that business rather than the first in the list, and the held address
is reopened only when the new session is in the same business. Choosing another
business deliberately is not refused: it goes to that business's board with a
notice (`role="status"`, `data-notice="other-business"`) naming the business the
held address belonged to. The token is never kept; the business key is the word
in the URL prefix and the word in the top bar.

The address and its business are kept in `sessionStorage` under
`ops-astro.return-to`, beside the session itself and under the same rule: never
`localStorage`, gone when the tab is, and spent the moment it is used. Signing
out clears it too, so an ordinary sign-in is never redirected by an interruption
somebody already answered.

No refresh-token call, no token inspection and no decoding anywhere in the web:
the hour is the server's to decide and the browser only ever finds out by being
refused. `tests/surfaces/session-ended.test.tsx` holds the three rules and
SX1–SX3 in `tests/browser/cases-session-expiry.mjs` show them in a real browser.

## Addresses

| Address      | What it draws                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `/sign-in`   | Credentials and the business selector                                                            |
| `/projects/` | `task.board` with `board: null` — the unboarded tasks — and the create form                      |
| `/task/:key` | `task.read`: state buttons, the assignee select, title and due date, comments, history, revision |
| `/settings`  | The two operation-classified business settings. It reads nothing — see below                     |

`/task/:key` is a real address. A hard reload lands on it because the dev server
falls back to `index.html`, and everything on the page is reread from the API.

## Comments on a task

`task.read` has carried the task's comments since L3 (`docs/local/API.md`);
`/task/:key` draws them. Each one is an `article[data-comment-id]` carrying
`data-audience`, and the audience is printed in words above the body, because
"who may read this" is the one thing the person writing the next comment needs
to know and the one thing a colour cannot say.

The form is `form#task-comment`: a required `textarea#comment-body`, a
`select#comment-audience` (internal or client) and a `select#comment-kind`, with
`button[data-comment="post"]`. Posting goes through `task.comment` with the
revision the page holds; that command writes a record beside the task and
**leaves the task's own revision alone**, so nothing else on the page goes stale
because somebody said something.

**The list is the server's.** After a post the screen rereads `task.read`; it
never appends the comment it just sent. A screen that appended would be drawing
a row that may never have been stored, which is B7's failure in friendlier
clothes.

**A refusal is quoted and the box is closed.** There is no grant read anywhere
in this build, so the screen cannot know whether a person holds `comment` before
it asks. It asks once; on `SCOPE_NOT_GRANTED` it draws the server's own code in
`p[data-comment="refusal"]`, disables the box and the button, and says why. A
second press reaches nothing — C2 counts the requests rather than trusting the
`disabled` attribute. Anything else the server refuses (an empty body, an
audience it does not have) is reported and the box stays open, because that is
something the person can fix.

Keyboard: the textarea, the two selects and the button are ordinary controls in
document order after the details form, each with a `label` bound by `htmlFor`.
Drawn at 1480, 900 and 390 with the rest of the page.

## The settings screen

`/settings` draws the two settings the model classifies `operation`:
`four_eyes_threshold` (a number of dollars, or off) and
`client_sign_off_required` (on or off). Each is written through the command that
owns it — `settings.set_four_eyes_threshold` and `settings.set_client_sign_off`
— with an `operationId` and no `expectedRevision`, because `business_settings`
carries no revision to be stale against.

**Nothing on this screen is read back, and the screen says so on the page.**
`COMMAND_SURFACE` declares four reads — `task.read`, `task.board`,
`person.list`, `preset.plan` — and none of them carries `business_settings`.
So the screen opens on _not known_ and names the absent read in
`p[data-settings="not-readable"]`. The number beside "Last confirmed by the
server" is the last write **this browser** had confirmed by the command's own
`detail` echo, held in `sessionStorage` under `ops-astro.settings.<business>`
— the same rule the session lives under, never `localStorage`.

Opening on the shipped default (`500`, `false`) was the alternative and it is
worse: a person would be shown their business's threshold having never asked
anybody, with no way to tell that number from a real one.

The refusal rule is the comment form's: ask once, quote
`SCOPE_NOT_GRANTED` verbatim in `p[data-settings="refusal"]`, close both
controls, change nothing. `/settings` carries a rail entry and the panel
registry's one entry (`panels.ts`), whose dock tab navigates to the address
rather than opening a drawer — the surface has a real address, and an address a
person can quote is worth more than a panel they cannot.

## What the five read states mean

`views/record-state.tsx` draws each one differently and never substitutes data:

- **loading** — the read is in flight.
- **ready** — rows arrived.
- **empty** — you are permitted to see the collection and it has no rows. Not a
  failure, and never drawn as one.
- **denied** — the server refused. Its code is shown verbatim, because a refusal
  a person cannot quote is a refusal they cannot get help with.
- **unavailable** — the API did not answer. Nothing has been decided about your
  access.

There is no path from a failed read to sample data anywhere in this application.

## Tests

```
pnpm exec vitest run --config tests/surfaces/vitest.config.ts
```

That config exists only because the root `vitest.config.ts` collects
`*.test.ts` and the two mounted tests are `*.test.tsx`. When the root config
gains `tests/**/*.test.tsx`, delete `tests/surfaces/vitest.config.ts` and use
`pnpm test`.

Four suites. The two `.ts` ones need no browser: route derivation and the
envelope against a stubbed `fetch`, and the generation/denial ordering in
`authorised-read.ts`. The two `.tsx` ones mount into jsdom, declared per file
with a `// @vitest-environment jsdom` docblock.

None of them touches the API, and none discharges a browser acceptance case.
They prove the wiring; B1–B7 prove the product.

## The browser checklist, in one command

```
pnpm verify:browser
```

That runs `tests/browser/slice-acceptance.mjs` against the stack already
serving on 5190/8790, writes every case into
`parent-observations/local-slice/RESULTS.md` with a screenshot each, and exits
non-zero if any case failed. It is the whole checklist in one place: B1–B7,
N1–N7 including the real N6 revocation harness, and the two review findings'
browser cases.

It is evidence, not a check, and it is not cheap: it stops the API, stops and
restarts the Postgres container (keeping the volume), and revokes and reissues
a live grant. Run it when you want the table, not on every edit.

The run is made of one module per case group, so a group can be read or
changed without reading the rest:

| File                     | Cases                                                       |
| ------------------------ | ----------------------------------------------------------- |
| `harness.mjs`            | sign-in, the in-page client, screenshots, the results table |
| `cases-b.mjs`            | B1–B5, the journey and the reload                           |
| `cases-n3-n5.mjs`        | protected fields, system fields, replay and revision        |
| `cases-n6-n7.mjs`        | N7 input tampering, N6 revocation (via `n6-revocation.mjs`) |
| `cases-n1-n2.mjs`        | another business, and a member with no grant                |
| `cases-create-retry.mjs` | R1, retrying a create whose answer was lost                 |
| `cases-task-drafts.mjs`  | D1, the explicit Save or Discard of an unsaved detail       |
| `cases-b6-b7.mjs`        | the API down, and the process and database restart          |
| `cases-comments.mjs`     | C1 a comment posted and reloaded, C2 a member refused once  |
| `cases-settings.mjs`     | S1 an admin sets the threshold, S2 a member is refused      |

`n6-revocation.mjs` and `keyboard-and-widths.mjs` also run on their own
(`node tests/browser/<file>`).

`pnpm verify:browser` exits zero only when **every** row passed. `writeResults`
returns the rows that did not — failed, pending and unrun together — so a run
that stopped early, or that recorded a required case as pending a sibling lane,
cannot leave the command looking like an accepted one. The `pending` and `unrun`
labels stay in the table, because they are what makes a partial run readable;
they just no longer buy a zero exit. Nothing is pending or unrun on this head.

### Cases address controls by attribute, not by text

Two buttons on `/task/:key` read **Save changes**: the edit form's own
`form#task-fields button[type="submit"]`, and the unsaved-changes bar's
`button[data-draft-resolve="save"]` (`apps/web/src/screens/TaskDetail.tsx:507`
and `:379`). Both submit the same form — the bar's is outside it and reaches it
through `form="task-fields"`, so a cleared title is refused by whichever one is
pressed. A case that asks for the button by its name matches both and
fails on the ambiguity, so B4 presses the form's submit — the honest control
for a case that edits the fields and then saves them. The three state buttons
are pressed through `button[data-lifecycle="start"|"complete"|"reopen"]` for
the same reason: an attribute the screen owns cannot be made ambiguous by a
second control that happens to share a word.

## Known gaps against the pinned mockup

Recorded rather than closed. The mockup is the visual source; these are the
places this build does not yet reach it.

- The board draws nine pinned columns; this build stores five of them. Rank,
  client, stage, estimate and actual draw the ported "not set" dash.
- No facet menu, presets, undo/redo, typeahead or column drag-resize.
- No Agent panel, gate or run surfaces, and no dock tab: the records they draw
  are not stored by this build, so the registry is empty rather than carrying a
  tab that opens onto nothing.
- Subtasks are not built. Comments are, and the task page draws them; the
  mockup's tabbed Internal / Client / All activity conversation is not — the
  comments are one list with each row's audience on it, and history stays its
  own section below.
- **The external comment projection is taken from the API's word, not
  exercised.** `task.read` gives a non-internal role the client comments in the
  `shared` fields only (`docs/local/AUTHORITY.md`), and the screen is written to
  draw whatever subset arrives. No seeded login has a role outside
  `owner`/`admin`/`member`, so no browser case reads the task as an external
  reader. The screen's handling of a partial projection is held by
  `tests/surfaces/task-comments.test.tsx` against a stand-in and by the shape's
  optional fields; a real external reader would be the proof and there is no
  identity in this build to be one.
- **`system` is not offered as a comment kind.** The API takes `note`, `client`
  and `system`; the form offers the first two. A system comment is one the
  product writes about itself, and a box letting a person post one by hand makes
  every system note on a task unreliable evidence of anything.
- **No settings read exists**, so `/settings` cannot show what a business holds
  — only what this browser last had confirmed. Named above and in the handback
  for the lane that owns the read surface.
- **No seeded identity holds `settings:manage`.** `scripts/local-seed.mjs` grants
  its admin six `task` actions and `person:read`; the settings commands take
  `manage` on the `settings` collection, which nobody is granted. `S1` issues
  that grant through `issueGrant` and revokes it in a `finally`, and restores
  the threshold it wrote, so the run leaves the business's grants and rows as it
  found them. The gap belongs to the seed's lane.
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
  built. The interruption keeps the business key -- the word in the URL prefix,
  never the token.
- Fonts and icons are not fetched. The redistribution question (#32) is open, so
  the families are a stack with real fallbacks and the brand is its own words.
- Layouts are written for 1480, 900 and 390. Photographed at all three, light
  and dark, on 2026-09-23 (`parent-observations/local-slice/width-<w>-<theme>-<page>.png`,
  `node tests/browser/keyboard-and-widths.mjs`). What the twelve captures show:
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
