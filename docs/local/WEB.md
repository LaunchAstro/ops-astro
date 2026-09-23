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

## Addresses

| Address      | What it draws                                                                          |
| ------------ | -------------------------------------------------------------------------------------- |
| `/sign-in`   | Credentials and the business selector                                                  |
| `/projects/` | `task.board` with `board: null` — the unboarded tasks — and the create form            |
| `/task/:key` | `task.read`: state buttons, the assignee select, title and due date, history, revision |

`/task/:key` is a real address. A hard reload lands on it because the dev server
falls back to `index.html`, and everything on the page is reread from the API.

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

## Known gaps against the pinned mockup

Recorded rather than closed. The mockup is the visual source; these are the
places this build does not yet reach it.

- The board draws nine pinned columns; this build stores five of them. Rank,
  client, stage, estimate and actual draw the ported "not set" dash.
- No facet menu, presets, undo/redo, typeahead or column drag-resize.
- No Agent panel, gate or run surfaces, and no dock tab: the records they draw
  are not stored by this build, so the registry is empty rather than carrying a
  tab that opens onto nothing.
- Comments and subtasks are not built. The task page shows history only.
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
