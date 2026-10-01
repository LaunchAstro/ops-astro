<!-- Public edition, generated from the private design-system source by ticket C82's build and checked by the real-names check before it crossed. Do not edit it here; the source changes and the copy is run again. Screenshots and review records stay private, so they are not linked. -->

# Ops Astro design system catalogue

Status, 27 September 2026 (lane SPEC-REVIEW-FOLD, after the spec-readiness review, gate 1): **ready to chart build tickets, except wayfinder inside Ops Astro; no capability row is held.** The two independent reviews (35 findings, 26 once merged) are settled and applied (`evidence/SPEC-REVIEW.md`). Wayfinder (C42, C43, C64, C65) waits on its proposed scoping map (`evidence/WAYFINDER-SCOPING.md`). The one build order is phase first, then slice ([`CAPABILITY-SLICES.md`, Build order](CAPABILITY-SLICES.md#build-order-phase-first-then-slice)), with slice 0 for the build safeguards. Before that, lane RESEARCH-FOLD set it build-ready on the 21 research notes. The 21 research tickets (#369 to #389) are answered and folded into the rows they change (`evidence/RESEARCH-FOLD.md`). The owner answered all 24 open items on 27 September, and each answer is written into the rows it held ([`CAPABILITY-SLICES.md`, Owner answers](CAPABILITY-SLICES.md#owner-answers); `evidence/OWNER-ANSWERS.md`). 98 canonical components (108 ids issued, 7 aliases, 3 retired), 264 variants, 132 tokens, 1,305 page-map rows (plus 167 fresh-audit rows), 640 placeholder rows, 373 capabilities (50 new candidates after C37 moved to Deferred; C66 to C68 from the research), 1,140 shots. The two independent audits (43 findings) and the research, security and scrub lanes are folded in (`evidence/AUDIT-RECONCILE.md`). Still with the owner, holding no row: the go to build, after the ticket review (gate 2), and three research lines, each with its recommendation written into the rows it touches as pending the owner (T7 the BigQuery exports' billing, T2 where Cal.com runs, T14 the verification-loop fixes). Staging (on the installation's own production machine, isolated from its live services) and the Xero plan (the free Starter plan, no paid plan) were decided on 27 September ([Still with the owner](CAPABILITY-SLICES.md#still-with-the-owner)). An installation's own settings are configuration, not product, and stay out of this public edition. Before anything crosses to the public product repository, the scrub's screenshot groups SG-1 to SG-4 (33 folders, 189 files) are recaptured on synthetic data (`evidence/SCRUB.md`). Build-ready means ready to build once the owner approves building (`DIRECTION.md`, point 8); it authorises nothing. (Earlier status, lane ANSWERS24: build-ready, 363 capabilities, the research tickets filed. Before that, lane AUDIT-RECONCILE: build-ready except 21 capability rows held on the owner's list; 359 capabilities, 24 open items. Before that, lane RULINGS-TP: 101 components, 268 variants, 318 capabilities, 9 open items.)

This is the one index of the Ops Astro design system. It answers to `DIRECTION.md`, where the owner asked for "a consistent cohesive design system that all lives in the same spot", with no duplicates "sitting in the background", and with "all of the different elements from each of the pages" pointing to one canonical home. Every component has one id and one entry; where two lanes described the same thing, one id stays canonical and the other is an alias in the table below. Every inventory element points to one of these ids in `PAGE-MAP.md`. Plan and document only: nothing here authorises building (DIRECTION.md, point 6).

Lane CONSOLIDATE, design-system pass wave 2, 26 September 2026. Ticket "Consolidate the catalogue and write the page map (#294)" on the map "Ops Astro design system" (#287). Amended 27 September 2026 by lane CROSSCHECK (#296) after the blind Astra review: three new ids, DR-64 and DR-65, and the corrections listed in `ASTRA-CROSSCHECK.md`. Amended again the same day by lane RECONCILE-LOOK (#325) against the fresh capability-first audit: three new ids (DS-PRIM-33, DS-COMP-40, DS-COMP-41), three sidebar defects (DS-SIDE-D20 to D22), look corrections in place, five page-map retargets and 167 fresh-audit page-map rows; see `evidence/RECONCILE-LOOK.md`. Amended at build-ready the same day by lane BUILDREADY (#297): every decided ruling written into its entry (the "Ruled" columns in "Drift and rulings" and the lane files' "Rulings, decided" tables), DS-PRIM-12 folded (DR-31), shots for DS-PRIM-33, DS-COMP-40 and DS-COMP-41, and the status line above; record in `evidence/BUILDREADY.md`. Amended again the same day by lane RULINGS-TP (#297): the 34 ticket-plan rulings still cited as open were triaged, their outcomes added below ("Ticket-plan rulings, pass 2") and written into `PLACEHOLDERS.md`, and the status line set to build-ready; record in `evidence/BUILDREADY.md`, "Pass 2".

## How to read an entry

- **Where the entries live.** `catalogue/PRIMITIVES.md` (DS-PRIM), `catalogue/COMPOSITES.md` (DS-COMP), `SIDEBAR.md` (DS-SIDE, the owner's "nail the sidebar"), `TASK-PAGE.md` (DS-TASK, the task page "built as it is in the mockup"). Tokens and text styles are `TOKENS.md` (DS-TOK).
- **Ids** are `DS-<family>-<n>`, numbered from 1, never renumbered and never reused. An alias keeps its heading and becomes a one-line pointer.
- **Each entry carries** its purpose, anatomy, the variants kept, states, measured styling (light and dark, token names from the capture tool's matcher), shots, construction cited as `file:line` in `dashboard-mockups` (evidence of intent, not clean code), usages by inventory element id, drift (other ways the mockup draws it: kept as a variant or dropped) and defects not to copy.
- **Shots** are under `shots/<family>/<folder>/`, one PNG per variant, state, width and theme, each 40 KB or less.
- **Rulings.** Each lane numbered its own questions (PRIMITIVES `PR1` to `PR23`, COMPOSITES `R1` to `R19`, TOKENS `R-TOK-1` to `R-TOK-12`, SIDEBAR `R-SIDE-1` to `R-SIDE-13`). Those labels are lane-local, and the COMPOSITES `R1` to `R19` collide with the ticket plan's `R1` to `R78` (`docs/mockup-inventory/TICKET-PLAN.md`, answered in `.local/design-system-2026-09-26/triage/triage.json`). **Never cite a lane label bare:** cite the `DR-<n>` id from "Drift and rulings" below, or a ticket-plan ruling as `TICKET-PLAN R<n>`.
- **Build to the ruling, not the mockup,** where a decided ticket-plan ruling differs from what the mockup draws. `TASK-PAGE.md` section 1 lists the ones that change the task page.

## How to read behaviour in this file

DIRECTION.md point 6: the look is canonical; the behaviour shows what the software must really do. Every entry's states, tokens, sizes, motion and shots are specified to build. What a control does in the mockup demonstrates a capability Ops Astro must really have. The build makes it real and tracked (the event or record it creates), as listed in [`PLACEHOLDERS.md`](PLACEHOLDERS.md) by catalogue id. The mockup's implementation (handlers, stored keys, demo-only states) is evidence of intent only, and bugs are never copied. Until a capability is real, its control is drawn disabled with its reason (TICKET-PLAN R56), never live and dead. Behaviour the owner stated as law in their own words is specified exactly and cites WIRING.md: the sidebar's operating laws (WIRING §34, in `SIDEBAR.md`) and the per-page sync (WIRING §50.1, DS-PRIM-25).

## The token file

`TOKENS.md` holds 132 canonical ids, DS-TOK-1 to DS-TOK-132: 109 single-value tokens (27 of them proposed) for colour, spacing, radius, shadow, motion and z-index, 23 canonical text styles (DS-TOK-107 to DS-TOK-129), and the three mock-data mark tokens added by the Astra cross-check (DS-TOK-130 to DS-TOK-132). Every component entry names its tokens from that file. `TOKENS.md` also maps the old SHELL ids for tokens and type (DS-C, DS-T, DS-S, DS-R, DS-E, DS-M) to DS-TOK ids; the component and state part of the old map is below. **Fonts and icons (TICKET-PLAN R52, #299 and #331):** Funnel Display, Funnel Sans and Chivo Mono are OFL and ship with their licence files. The mockup's Flaticon UIcons are not shipped (their free licence is non-transferable and credit-bound), and the build uses an open-licence icon set (MIT, ISC or Apache) drawn to match the regular rounded style. The choice of set belongs to the design-system foundation slice.

## Components by area

### Sidebar: the dock (Part 1, the reference)

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-SIDE-1](SIDEBAR.md#ds-side-1-dock-edge-rail) | Dock edge rail | A fixed strip of permanent doors, one per panel | 3 | 3 |
| [DS-SIDE-2](SIDEBAR.md#ds-side-2-dock-tab) | Dock tab | The permanent door to one panel | 2 | 1 |
| [DS-SIDE-3](SIDEBAR.md#ds-side-3-dock-tab-callout) | Dock tab callout | Name an icon-only tab | 1 | 1 |
| [DS-SIDE-4](SIDEBAR.md#ds-side-4-dock-count-chip) | Dock count chip | A derived, uncapped count on a tab | 1 | 3 |
| [DS-SIDE-5](SIDEBAR.md#ds-side-5-close-all) | Close all | Close every open panel at once | 1 | 1 |
| [DS-SIDE-6](SIDEBAR.md#ds-side-6-sheet-tab-strip) | Sheet tab strip | The dock's rail turned 90 degrees for the 901 to 1279 tier | 1 | 1 |
| [DS-SIDE-7](SIDEBAR.md#ds-side-7-dock-panel) | Dock panel | A place beside the page: one resident (Team, Projects, Task and so on) with a permanent door | 5 | 1 |
| [DS-SIDE-8](SIDEBAR.md#ds-side-8-panel-head) | Panel head | Name the place, carry the view's own controls, and close it | 1 (absorbs DS-COMP-21) | 10 |
| [DS-SIDE-9](SIDEBAR.md#ds-side-9-panel-head-button-close-back-forward) | Panel head button (close, back, forward) | The dock's own control group, right of the divider: back and forward walk the dock's history, and X closes this panel only | 2 | 8 |
| [DS-SIDE-10](SIDEBAR.md#ds-side-10-panel-width-grip) | Panel width grip | Drag every panel's shared width (or the sheet's height) | 2 (dock and rail (axis)) | 2 |

### Sidebar: the left rail (Part 2)

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-SIDE-11](SIDEBAR.md#ds-side-11-navigation-rail) | Navigation rail | The Hub's one-level map: which section you are in | 5 | 2 |
| [DS-SIDE-12](SIDEBAR.md#ds-side-12-rail-brand) | Rail brand | Identity at the top of the rail | 2 | 2 |
| [DS-SIDE-13](SIDEBAR.md#ds-side-13-rail-item) | Rail item | One Hub section (or one client section inside a client) | 1 | 2 |
| [DS-SIDE-14](SIDEBAR.md#ds-side-14-railmark) | Railmark | The accent bar that says which section you are in, and slides when that changes | 1 | 1 |
| [DS-SIDE-15](SIDEBAR.md#ds-side-15-rail-fold-button) | Rail fold button | Collapse or expand the rail | 1 | 1 |
| [DS-SIDE-17](SIDEBAR.md#ds-side-17-navigation-toggle-hamburger) | Navigation toggle (hamburger) | Open the rail drawer at ≤ 900 | 1 | 1 |
| [DS-SIDE-18](SIDEBAR.md#ds-side-18-drawer-backdrop) | Drawer backdrop | Dim the page behind the open drawer; a click on it closes the drawer | 1 | 1 |
| [DS-SIDE-19](SIDEBAR.md#ds-side-19-client-workspace-group) | Client workspace group | Inside one client, the rail holds that client's sections, plus a way back to the client list | 1 | 2 |

### Chrome

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-COMP-1](catalogue/COMPOSITES.md#ds-comp-1-app-strip) | App strip | The dark strip across the top of every page: history, the client identity on client pages, global search, presence, the face switch and the timer | 3 | 9 |
| [DS-COMP-2](catalogue/COMPOSITES.md#ds-comp-2-tab-row-and-tab-mark) | Tab row and tab mark | The section's sub-pages as a row of tabs under the strip, with a sliding accent underline that carries across page loads | 1 | 5 |
| [DS-COMP-3](catalogue/COMPOSITES.md#ds-comp-3-page-header) | Page header | Names the page and holds its page-level controls: the title on the left; on the right a meta slot with the freshness marker, a placeholder chip, or page control | 4 | 18 |

### Actions and inputs

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-PRIM-1](catalogue/PRIMITIVES.md#ds-prim-1-button) | Button | The one text button for every action | 6 | 156 |
| [DS-PRIM-2](catalogue/PRIMITIVES.md#ds-prim-2-icon-button-including-close-) | Icon button (including close ×) | A square, icon-only action: close, dismiss, ask the agent, open, expand, edit, remove | 5 | 91 |
| [DS-PRIM-3](catalogue/PRIMITIVES.md#ds-prim-3-text-input) | Text input | One line of typed text | 2 | 11 |
| [DS-PRIM-4](catalogue/PRIMITIVES.md#ds-prim-4-textarea) | Textarea | Several lines of typed text | 2 | 7 |
| [DS-PRIM-5](catalogue/PRIMITIVES.md#ds-prim-5-select) | Select | Choose one value from a short list | 3 | 27 |
| [DS-PRIM-6](catalogue/PRIMITIVES.md#ds-prim-6-search-box-and-keycap) | Search box and keycap | Type to find or filter within a surface | 4 | 5 |
| [DS-PRIM-7](catalogue/PRIMITIVES.md#ds-prim-7-checkbox) | Checkbox | Tick an item done, or pick several | 2 | 2 |
| [DS-PRIM-9](catalogue/PRIMITIVES.md#ds-prim-9-switch) | Switch | Turn a standing setting on or off, with immediate effect | 1 | 1 (fresh-audit FA-PORTAL-114, the client's email-notification switch; OP-24) |
| [DS-PRIM-10](catalogue/PRIMITIVES.md#ds-prim-10-segmented-control-and-facet) | Segmented control and facet | Pick one of two to five options that switch a view or filter in place | 3 | 26 |
| [DS-PRIM-31](catalogue/PRIMITIVES.md#ds-prim-31-disclosure-chevron) | Disclosure chevron | Show and hide a row's or block's detail | 1 | 1 |

### Labels, marks and status

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-PRIM-11](catalogue/PRIMITIVES.md#ds-prim-11-chip-and-pill) | Chip and pill | A short label that classifies: state, kind, count, scope, a filter in force, a suggestion | 5 | 24 |
| [DS-PRIM-13](catalogue/PRIMITIVES.md#ds-prim-13-count) | Count | A number of things waiting (unread, comments, items in a filter) | 5 (incl. the numeral, from DS-PRIM-12) | 2 |
| [DS-PRIM-14](catalogue/PRIMITIVES.md#ds-prim-14-dot-and-status-line) | Dot and status line | The smallest status carrier, beside a label | 2 | 1 |
| [DS-PRIM-15](catalogue/PRIMITIVES.md#ds-prim-15-status-mark-text-and-chip) | Status mark (text and chip) | Say an object's state in words, in the status colour | 3 | 14 |
| [DS-PRIM-16](catalogue/PRIMITIVES.md#ds-prim-16-avatar-and-avatar-stack) | Avatar and avatar stack | Show who: a person (round) or a client (square) | 4 | 5 |
| [DS-PRIM-17](catalogue/PRIMITIVES.md#ds-prim-17-icon-and-door-mark) | Icon and door mark | Glyphs for actions and objects; the door mark says where a link goes | 2 | 1 |
| [DS-PRIM-25](catalogue/PRIMITIVES.md#ds-prim-25-marker-tag-stamp-index-and-freshness) | Marker, tag, stamp, index and freshness | The mono voice that labels, dates and indexes: section labels, field keys, timestamps, freshness | 6 (incl. the kind badge, from DS-PRIM-12) | 45 |
| [DS-PRIM-26](catalogue/PRIMITIVES.md#ds-prim-26-link-and-door-link) | Link and door link | Go somewhere: another page, a dock panel, an outside site | 3 | 41 |
| [DS-PRIM-27](catalogue/PRIMITIVES.md#ds-prim-27-divider-and-rule) | Divider and rule | Separate groups | 3 | 2 |

### Overlays

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-PRIM-18](catalogue/PRIMITIVES.md#ds-prim-18-tooltip-and-callout) | Tooltip and callout | Explain a term or name an icon without taking space | 4 | 9 |
| [DS-PRIM-19](catalogue/PRIMITIVES.md#ds-prim-19-menu-and-popover) | Menu and popover | A list of options or a small panel opened from a control, over the page | 3 (absorbs DS-COMP-24) | 5 |
| [DS-COMP-25](catalogue/COMPOSITES.md#ds-comp-25-modal-sheet-and-drawer) | Modal, sheet and drawer | Recorded so the gap is visible: the mockup has **no modal dialog** | 2 (no modal exists) | 1 |

### Data and containers

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-PRIM-20](catalogue/PRIMITIVES.md#ds-prim-20-table-and-cells) | Table and cells | Rows of like records with comparable columns | 3 | 84 |
| [DS-PRIM-21](catalogue/PRIMITIVES.md#ds-prim-21-card-base) | Card (base) | A bordered group for one topic on a page | 3 | 0 |
| [DS-PRIM-23](catalogue/PRIMITIVES.md#ds-prim-23-meter-and-progress) | Meter and progress | How much of a whole: capacity used, a score, progress to a target | 3 | 9 |
| [DS-PRIM-24](catalogue/PRIMITIVES.md#ds-prim-24-kpi-number) | KPI number | One headline figure with its label, optional "of N", optional track and optional change | 3 | 5 |

### Feedback states

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-PRIM-22](catalogue/PRIMITIVES.md#ds-prim-22-banner-and-tip) | Banner and tip | A message about the section or page: a warning, a failure, or a dismissible explainer (tip) | 4 | 19 |
| [DS-PRIM-28](catalogue/PRIMITIVES.md#ds-prim-28-empty-state) | Empty state | Say there is nothing here yet, why, and what to do next | 3 (plus a `--filtered` modifier) | 22 |
| [DS-PRIM-29](catalogue/PRIMITIVES.md#ds-prim-29-loading-state-gap-proposed) | Loading state (gap, proposed) |  | 3 (gap: three adopted, DR-37) | 0 |
| [DS-PRIM-30](catalogue/PRIMITIVES.md#ds-prim-30-error-state) | Error state | Say something failed, where, and what to do | 3 | 1 |
| [DS-PRIM-32](catalogue/PRIMITIVES.md#ds-prim-32-mock-data-mark) | Mock-data mark | Show at a glance which regions carry sample data (demo installs only, R56); added by the Astra cross-check | 3 | 1 |
| [DS-PRIM-33](catalogue/PRIMITIVES.md#ds-prim-33-locate-flash) | Locate flash | Show where a deep link landed: one accent ring pulse on the target; added by RECONCILE-LOOK | 1 | 0 (fresh-audit rows only) |

### Page structure

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-COMP-4](catalogue/COMPOSITES.md#ds-comp-4-section-head) | Section head | Opens a numbered section of a page: an index and an optional right-hand marker on a top rule, then the section title, then an optional tip | 4 | 50 |
| [DS-COMP-5](catalogue/COMPOSITES.md#ds-comp-5-tip-and-alert-strips-placement) | Tip and alert strips (placement) | Where the page-level strips sit and which one to use | 5 | 18 |
| [DS-COMP-12](catalogue/COMPOSITES.md#ds-comp-12-disclosure-layer) | Disclosure layer | A collapsible band of a page that holds deeper detail under a one-line summary | 1 | 32 |
| [DS-COMP-31](catalogue/COMPOSITES.md#ds-comp-31-hero) | Hero | The opening block of the client home and the weekly report: a greeting or headline with a few big figures | 2 | 6 |
| [DS-COMP-34](catalogue/COMPOSITES.md#ds-comp-34-journey-map) | Journey map | The Activation map: a client's journey as stages on a line, a reader panel for the picked stage, and the operations under it | 1 | 6 |

### Cards

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-COMP-6](catalogue/COMPOSITES.md#ds-comp-6-stat-row) | Stat row | A row of headline figures: label, number, optional track and foot, under a dotted rule | 3 | 21 |
| [DS-COMP-7](catalogue/COMPOSITES.md#ds-comp-7-card-content-and-list-card) | Card (content and list card) | The bordered surface that holds a block of content, a list or a chart | 3 | 73 |
| [DS-COMP-8](catalogue/COMPOSITES.md#ds-comp-8-door-card) | Door card | A card, row or strip that is itself a link to another page | 5 | 31 |
| [DS-COMP-9](catalogue/COMPOSITES.md#ds-comp-9-verdict-strip) | Verdict strip | The page's answer first: a bordered block of verdict rows, each a status band, a headline sentence and its period | 4 | 27 |
| [DS-COMP-10](catalogue/COMPOSITES.md#ds-comp-10-finding-card) | Finding card | A suggested finding with its evidence and a next move, marked as machine-made | 2 | 9 |
| [DS-COMP-11](catalogue/COMPOSITES.md#ds-comp-11-recommendation-card) | Recommendation card | One recommendation in a report, with its reason, the ask, the decision buttons and its history | 4 | 14 |
| [DS-COMP-32](catalogue/COMPOSITES.md#ds-comp-32-meeting-card) | Meeting card | The next meeting: kind, a mini calendar, the details and a primary action | 1 | 6 |
| [DS-COMP-39](catalogue/COMPOSITES.md#ds-comp-39-media-tile) | Media tile | Stand in for a photo, video or ad creative, and hold it once it exists; added by the Astra cross-check | 2 | 1 |

### Lists and conversation

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-COMP-13](catalogue/COMPOSITES.md#ds-comp-13-list-row) | List row | One row in a list that is not a board: a page list inside a card, or a list inside a dock panel | 4 | 52 |
| [DS-COMP-14](catalogue/COMPOSITES.md#ds-comp-14-feed-and-ledger) | Feed and ledger | Things that happened, in time order: the attention feed, the activity ledger (work log), the CRM ledger and the notification feed | 5 (incl. `trail` (DS-TASK-8)) | 15 |
| [DS-COMP-33](catalogue/COMPOSITES.md#ds-comp-33-source-rows) | Source rows | Under a number, the list of sources that corroborate it, one line each | 1 | 7 |
| [DS-COMP-15](catalogue/COMPOSITES.md#ds-comp-15-message-thread-and-composer) | Message thread and composer | A conversation: messages in order, then a composer pinned at the foot | 2 | 15 |

### Boards

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-COMP-16](catalogue/COMPOSITES.md#ds-comp-16-filter-and-command-bar) | Filter and command bar | The bar above a board or list that narrows and acts on it: search, facets, presets, a funnel menu and actions | 3 | 17 |
| [DS-COMP-17](catalogue/COMPOSITES.md#ds-comp-17-board-table) | Board table | The board is a table, not a kanban: column heads that sort and resize, group rows, then task or client rows with hover tools | 4 | 35 |
| [DS-COMP-18](catalogue/COMPOSITES.md#ds-comp-18-board-card) | Board card | A card for one piece of work under review: title, status, the thing to look at, the conversation and the decision | 3 | 8 |
| [DS-COMP-19](catalogue/COMPOSITES.md#ds-comp-19-stage-strip) | Stage strip | The client board's strip of stages across the top: each stage a small card with a capacity row, one of them picked | 1 | 6 |
| [DS-COMP-20](catalogue/COMPOSITES.md#ds-comp-20-roadmap-columns) | Roadmap columns | The only true columns in the mockup: the client growth roadmap as Now, Next and Later columns of items | 1 | 5 |

### Dock interiors

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-COMP-22](catalogue/COMPOSITES.md#ds-comp-22-dock-panel-body-parts) | Dock panel body parts | The repeated parts that make up a panel body | 11 (parts, plus `tag field` (DS-TASK-2)) | 25 |
| [DS-COMP-23](catalogue/COMPOSITES.md#ds-comp-23-panel-tab-set) | Panel tab set | Tabs inside a panel: the notification kinds, and the AI conversations (which can be added, renamed and closed) | 2 | 10 |

### Forms

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-COMP-26](catalogue/COMPOSITES.md#ds-comp-26-form-layout) | Form layout | How fields are laid out in a form: a tinted block of labelled fields in a grid, with actions at the foot | 4 | 15 |
| [DS-COMP-38](catalogue/COMPOSITES.md#ds-comp-38-calendar-and-date-grid) | Calendar and date grid | Pick or read a day and a time: the date picker grid, the week strip, the booking day list, slots and meeting-type tiles; added by the Astra cross-check | 5 | 6 |

### Charts

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-COMP-27](catalogue/COMPOSITES.md#ds-comp-27-axis-chart-line-column) | Axis chart (line, column) | A value over time on axes | 2 | 7 |
| [DS-COMP-28](catalogue/COMPOSITES.md#ds-comp-28-radial-chart-donut-gauge-score-dial) | Radial chart (donut, gauge, score dial) | A share of a whole or a score against a target | 3 | 7 |
| [DS-COMP-29](catalogue/COMPOSITES.md#ds-comp-29-inline-chart-sparkline-bar-list-band-track) | Inline chart (sparkline, bar list, band track) | A small chart that sits inside a row, a stat or a card | 4 | 11 |
| [DS-COMP-30](catalogue/COMPOSITES.md#ds-comp-30-project-timeline-gantt) | Project timeline (Gantt) | The client's projects as bars across weeks, on the Brief | 1 | 3 |
| [DS-COMP-40](catalogue/COMPOSITES.md#ds-comp-40-funnel-chart) | Funnel chart | A conversion funnel drawn to true scale, stage by stage; added by RECONCILE-LOOK | 2 | 1 |

### Page patterns

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-COMP-35](catalogue/COMPOSITES.md#ds-comp-35-client-face-deltas) | Client face deltas | One list of what changes on each composite when the client, not the agency, is looking | n/a (cross-reference table) | 0 |
| [DS-COMP-37](catalogue/COMPOSITES.md#ds-comp-37-report-layouts) | Report layouts | The page frames of the client reports | 4 (incl. `agent perspective` (DS-TASK-15)) | 3 |

### Task page

| Id | Component | Purpose | Variants | Page-map rows |
|---|---|---|---|---|
| [DS-TASK-1](TASK-PAGE.md#ds-task-1-task-fact-strip) | Task fact strip | The task's derived facts and its two handling ticks in one row above the fields: Whose move, Rank, Ad hoc, Client access | 3 | 5 |
| [DS-TASK-3](TASK-PAGE.md#ds-task-3-scope-stamp) | Scope stamp | Say, read-only, what an agent may touch on this task: client × lane × clearance, and who holds live leases | 2 | 2 |
| [DS-TASK-4](TASK-PAGE.md#ds-task-4-run-summary) | Run summary | The current run in one block: attempt, executor, state, a sentence, and four facts | 2 | 2 |
| [DS-TASK-5](TASK-PAGE.md#ds-task-5-workflow-list) | Workflow list | The run's jobs in order, parallel siblings grouped, behind a toggle | 1 | 2 |
| [DS-TASK-6](TASK-PAGE.md#ds-task-6-output-and-evidence-box) | Output and evidence box | One framed box for "what exactly changes if you say yes" and the other evidence blocks of a run | 4 | 5 |
| [DS-TASK-7](TASK-PAGE.md#ds-task-7-gate-box) | Gate box | The human approval gate: what is waiting, on whom, bound to which exact version, and the two decisions | 2 | 3 |
| [DS-TASK-9](TASK-PAGE.md#ds-task-9-token-tracked) | Token tracked | The agent's token allowance against what was spent, and one row per run | 2 | 2 |
| [DS-TASK-10](TASK-PAGE.md#ds-task-10-rank-calculation) | Rank calculation | Show how the rank is derived, so it is never a number nobody can trace | 3 | 2 |
| [DS-TASK-11](TASK-PAGE.md#ds-task-11-task-record-header-and-facts-band) | Task record header and facts band | The task at reading scale: where it lives, its id and state, its name, where its run is, then its facts | 1 | 3 |
| [DS-TASK-12](TASK-PAGE.md#ds-task-12-execution-graph) | Execution graph | The run's jobs as a read-only derived map: columns by depth, connectors by dependency, one node selected into the inspector. **Likely replaced:** depends on the harness decision (LangGraph or Langflow may bring their own view); no connector work until then | 2 | 2 |
| [DS-TASK-13](TASK-PAGE.md#ds-task-13-graph-node-card) | Graph node card | One job in the map: key, state, title, owner and what it outputs, needs, waits on or stopped at | 4 | 1 |
| [DS-TASK-14](TASK-PAGE.md#ds-task-14-graph-inspector) | Graph inspector | Everything about the selected job, under the map | 1 | 1 |

## Alias table

A pointer from a retired id (or part of an entry) to its one canonical home. Each retired entry keeps its heading and now reads as a one-line pointer; detail it held that the canonical entry lacks is carried in the next section.

| Retired | Canonical | Kind | Reason |
|---|---|---|---|
| DS-COMP-41 Rank grid | none: retired | retired, no use | Retired 27 September 2026 (AUDIT-RECONCILE, OP-23, AS-15): C27 local rank geo-grid is out of scope (the owner, 27 September, `research/LOCAL-RANK-GRID.md`; CS-13.36); LR-W03 maps to `content` (dropped). The entry keeps its heading as evidence; it is not built. |
| DS-COMP-36 Placeholder page | none: retired | retired, no use | Retired 27 September 2026 (AUDIT-RECONCILE, AS-16): a mockup device, not a product page (R2 (a): an undesigned address is left out of the navigation and a typed address shows the one empty state, DS-PRIM-28); its 8 inventory rows and 13 fresh-audit rows now map to DS-PRIM-28. The entry keeps its heading as evidence; it is not built. |
| DS-PRIM-8 Radio | none: retired | retired, no use | Retired 27 September 2026 (AUDIT-RECONCILE, OP-24): nothing drawn, no page, register row or ticket uses it; single choices are DS-PRIM-10; the build adds a radio only when a ticket needs one. The entry keeps its heading as evidence; it is not built. |
| DS-COMP-21 Dock panel header | DS-SIDE-8 Panel head (buttons DS-SIDE-9) | duplicate | Both specify `.dpanel__head` with the same measurements (549 × 59, padding 16 16 16 24, 1px bottom `--border`) and the same usages (DK-08 to DK-13, CL-01 to CL-04, PJ-01, AI-01 to AI-05, TASKS DP-01 to DP-07). The dock is the reference (#298), so SIDEBAR's id stays. |
| DS-COMP-24 Popover menu | DS-PRIM-19 Menu and popover | duplicate | Both claim `.sel__menu`, `.cbd__menu`, `.dp__pop` and `.bkpop` with overlapping usages. The primitive is the lower level and COMPOSITES itself hands `.oncal__pop` to PRIMITIVES. Their disagreement is DR-4. |
| DS-SIDE-16 Rail width grip | DS-SIDE-10 Panel width grip | duplicate | Identical size, colour and cursor; SIDEBAR's own drift line says "keep them as one component, edge grip, with an axis prop". |
| DS-TASK-2 Tag field | DS-COMP-22 Dock panel body parts, variant `tag field` | fold | Proposed by TASK-PAGE. DS-TASK-2 stays as the variant's spec (anatomy, states, shots, the Esc handling to copy). |
| DS-TASK-8 Task trail | DS-COMP-14 Feed and ledger, variant `trail` | fold | Proposed by TASK-PAGE; `.sbact` was claimed by both. DS-TASK-8 stays as the variant's spec. |
| DS-TASK-15 Agent perspective grid | DS-COMP-37 Report layouts (page layouts), variant `agent perspective` | fold | Proposed by TASK-PAGE: a page layout, not a component. DS-TASK-15 stays as the variant's spec. |
| DS-PRIM-10 usage `.cmtabs` / `.cmtab` (NT-03, DP-11, DP-12, DT-14, TT-04) | DS-COMP-23 Panel tab set | duplicate usage | The Team / Agent switch and the notification kinds are one tab set; PRIMITIVES listed them under the segmented control too. The usage lines in DS-PRIM-10 now point to DS-COMP-23. |
| DS-COMP-5 drift item `.gate` (AG-C56) | DS-TASK-7 Gate box (its `.gate` card) | one home | COMPOSITES dropped `.gate` as a strip dialect while TASK-PAGE builds the gate card on it; AG-C56's executor gate is the same card. Its 3px rule is DR-9. |
| DS-COMP-22 part "Panel search" (`.cl__find`, `.dcs__search`, `.tsearch`) | DS-PRIM-6 Search box, dock panel search variant | duplicate part | DS-PRIM-6 already specifies the dock search, including the token variant. |
| DS-TASK-5 Workflow list, its toggle | DS-COMP-12 Disclosure layer | partial fold | The toggle is the disclosure pattern; the job rows stay DS-TASK-5. |
| DS-PRIM-12 Badge | DS-PRIM-25 Marker (variant `kind badge`) and DS-PRIM-13 Count (variant `numeral`) | fold | Ruled by DR-31 (27 September 2026, applied at build-ready). DS-PRIM-12 stays as the two variants' spec (styling, shots); no page-map row targeted it. |

**Corrected, not aliased.** DS-COMP-25 recorded the task body `.sb` as a fixed right-hand drawer. It is not one: since 28 July it mounts inside the dock's Task panel (`ui.js:6262-6285`, DS-SIDE-7), and the drawer rule `app.css:3769-3775` is dead (TASK-PAGE defect row 43). The `sideboard` item and its construction citations were removed from DS-COMP-25. TOKENS' R-TOK-12 (the `.sb` layer at z 72) rests on the same dead rule: see DR-19.

**Built on, not aliases.** Where a host part specifies how a primitive is placed and behaves in one place, the host part owns the page element and the primitive is what it is built on. The primitive's usage line for that host reads as "built on", not as a second home: DS-SIDE-3 on DS-PRIM-18 (tooltip), DS-SIDE-4 on DS-PRIM-13 (`.cbadge--corner`), DS-SIDE-9, DS-SIDE-15 and DS-SIDE-17 on DS-PRIM-2 (icon button), DS-COMP-5 on DS-PRIM-22 (banner), DS-COMP-6 on DS-PRIM-24 (KPI number), DS-COMP-7 on DS-PRIM-21 (card), DS-COMP-17 on DS-PRIM-20 (table).

## Carried from retired entries

Detail the retired entries held that their canonical entries do not, kept here so nothing is lost and every shot stays linked.

**From DS-COMP-21 (now DS-SIDE-8).** The head's view slots, per panel, left to right:

| Panel | Controls, in order |
|---|---|
| notes, marks, team, notifs | title, back, forward, close |
| todos | title, open as page, divider, back, forward, close |
| clients | title, open as page, divider, back, forward, stamp, sync, divider, close |
| task | title, new, go to, open as page, full, divider, back, forward, close (`TASK-PAGE.md` S1) |
| ai | title, model select, eye, divider, back, forward, close |

- Construction it cited beyond DS-SIDE-8: `dockboot.js:298-315` (clients), `dockboot.js:372-471` (task); stamp `.dpanel__stamp` `app.css:6606`; the AI head `dock-ai.js:145-200`, `303-315`, `.aip__head` `app.css:695`, `.aip__actdiv` `app.css:2897`, `.aip__x` `app.css:2451-2462`, `2901`, `.aip__act` `app.css:1737`.
- The AI head's drift (drop it for the one head, DR-3): align `flex-start`, padding `--s-4 --s-5` all round, a full-height divider, close `--text-muted` 1rem with accent hover that rotates 90° at ≤ 900, action buttons with padding, title a `div`.
- Defects: head buttons borrow each other's classes (DOCK D-26), the Clients head has two dividers (D-21), Escape in a panel field closes the panel (D-22).
- Shots (1480): notifs light · dark; todos light · dark; clients light · dark; AI drift light · dark; close focus-visible light · dark.

**From DS-COMP-24 (now DS-PRIM-19).**
- Variant names it used: `select menu` (`.sel__menu`), `board menu` (`.cbd__menu`, and `.cbdta__menu` for typeahead), `inline pop` (`.bkpop`, in flow, kept by COMPOSITES and listed as drift by PRIMITIVES: DR-4). Measured `.sel__menu` 240 × 117, ground `--bg`, 1px `--accent` border, `--shadow-overlay`, z 40; `.cbd__menu` z 45, width min(22rem). Opening animation `app.css:2231`. Other hand-rolled pops it counted: `.tgs__menu` `app.css:11175`, slot pop `.slot` `app.css:3406-3411`, `mountBookPop` `ui.js:2907`.
- Usages it listed that DS-PRIM-19 does not: AGENCY AG-C48, AG-C54; BOARDS P-65; CLIENT BR-20, BR-22 to BR-24; WORKBENCH SI-M12; DOCK CR-12, CR-13.
- Defects: the funnel menu breaks the 16px gutter at 390 (BOARDS D-22); the AI model menu is clamped by a one-off rule (`app.css:11571`).
- Shots (1480): board menu light · dark; select menu light · dark.

**From DS-SIDE-16 (now DS-SIDE-10, rail axis).**
- `div.railgrip[aria-hidden]`, absolute at `right: -3px`, 6 px wide, full height, `col-resize`, z 5 (`app.css:1467-1470`). Hover and dragging (`.active`): `--accent-ring` with no transition (`app.css:1471`). Hidden when collapsed (`:1660`) and at ≤ 900 (`:1472`). Construction `portal.js:648-682`. Usage SHELL SH-8.
- Unlike the panel grip it does not suspend transitions while dragging; keep the panel grip's behaviour for both (DR-56 asks the same for the drag itself).
- Defects: DS-SIDE-D4 (lags the cursor by 420 ms), D11 (writes storage on every move), D12 (mouse only).
- Shots (1480): idle light · idle dark · hover light · hover dark.

**Additions from TASK-PAGE**: DS-COMP-13 List row carries the task states `gate step` and `archived` (written into the entry at build-ready, 27 September 2026).

**Motion key frames.** SIDEBAR links each motion run's contact strip; the timed key frames of every run sit beside the strips in `shots/sidebar/DS-SIDE-7/motion/`, `shots/sidebar/DS-SIDE-11/motion/` and `shots/sidebar/DS-SIDE-14/motion/` (four frames per run and theme, named `<run>-<theme>-f<frame>-<ms>.png`).

## Old SHELL ids to canonical ids

`docs/mockup-inventory/SHELL.md` section 1 gave the mockup's baseline ids that every inventory lane cites. The token and type part (DS-C, DS-T, DS-S, DS-R, DS-E, DS-M) is mapped in `TOKENS.md`, "Old ids to new ids". The component, state and icon part:

| Old id | What | Canonical id |
|---|---|---|
| DS-K1 | `.btn` | DS-PRIM-1 |
| DS-K2 | `.btn--primary` | DS-PRIM-1, variant `--primary` |
| DS-K3 | `.btn` variants and sizes; `--icon` | DS-PRIM-1; `--icon` is DS-PRIM-2 |
| DS-K4 | `.chip` | DS-PRIM-11 |
| DS-K5 | `.segmented` | DS-PRIM-10 |
| DS-K6 | `.meter` | DS-PRIM-23 |
| DS-K7 | `.table` | DS-PRIM-20 |
| DS-K8 | `.card` | DS-PRIM-21 |
| DS-K9 | `.banner` and `.banner__x` | DS-PRIM-22 (dismiss is DS-PRIM-2; placements DS-COMP-5) |
| DS-K10 | Tooltip `.term` | DS-PRIM-18 |
| DS-K11 | Dock-tab callout | DS-SIDE-3, built on DS-PRIM-18 |
| DS-K12 | `.marker`, `.u-tag`, `.stamp`, `.index` | DS-PRIM-25 |
| DS-K13 | `statusDot`, `statusChip`, `statusPill` | DS-PRIM-14 (dot); DS-PRIM-15 (chip, text) |
| DS-K14 | `.stat`, `kpi`, `kpiSm` | DS-PRIM-24 (the row of them is DS-COMP-6) |
| DS-K15 | `freshness()`, `.marker.fresh` | DS-PRIM-25, freshness |
| DS-K16 | Hub `.switch`, `.input`, `.field`, `.badge`, `.count`, `.dot` (no call sites) | DS-PRIM-9, DS-PRIM-3, DS-PRIM-3, DS-PRIM-12 (folded by DR-31 into DS-PRIM-25 and DS-PRIM-13), DS-PRIM-13, DS-PRIM-14 |
| DS-K17 | `.u-pill` | DS-PRIM-11 |
| DS-F1 | Global focus ring | PRIMITIVES "Shared state rules"; token DS-TOK-77 `--focus-ring`; DR-1 |
| DS-F2 | Button focus outline | DS-PRIM-1 (proposed dropped, DR-1) |
| DS-F3 | Hover rules in the shell | Rail item DS-SIDE-13; tab row DS-COMP-2; app strip DS-COMP-1; dock rows DS-COMP-13 `panel row`; dock tab DS-SIDE-2; segmented DS-PRIM-10 |
| DS-F4 | Door marks follow their host | DS-PRIM-17 |
| DS-F5 | Rail fold focus | DS-SIDE-15 |
| DS-X1 | Empty | DS-PRIM-28 |
| DS-X2 | Loading | DS-PRIM-29 (gap, proposed) |
| DS-X3 | Error | DS-PRIM-30 |
| DS-X4 | Unwired | Not ported as a visual (a port instruction) |
| DS-X5 | Mock mark | DS-PRIM-32 (R56 keeps it in demo installs; corrected by the Astra cross-check) |
| DS-I1 | Icon font | DS-PRIM-17 |
| DS-I2 | Door-mark vocabulary | DS-PRIM-17, DS-PRIM-26 |
| DS-I3 | Door-mark dress | DS-PRIM-17 |
| DS-I4 | Logos | DS-SIDE-12 (rail) and DS-COMP-1 (app strip) |
| DS-I5 | No emoji, ever | DS-PRIM-17 (the rule stands) |

## Drift and rulings

Every question the lanes raised, deduplicated and given one id. `DR-<n>` ids are this catalogue's and never reused. **All are ruled.** DR-64 and DR-65 were ruled by the owner's answers of 27 September (`CAPABILITY-SLICES.md`, "Owner answers", items 8 and 9). The "Ruled" column gives the ruling (26 September 2026, the triage of the `DR` rulings on the map "Ops Astro design system", #287): answered from the owner's recorded words, decided under their bar (DIRECTION point 7; they can veto), or behaviour (specified in `PLACEHOLDERS.md`, "Behaviour decided"). Each ruling is written into its entry; `evidence/BUILDREADY.md` lists where. "Sources" gives the lane-local label and file, so each can be traced. Where a decided ticket-plan ruling already answers part of a question, the row says so.

**Merged or raised at consolidation** (DR-1 to DR-9): where two lanes asked the same question, or disagreed, one row now holds it.

| DR | Question | Options | Lanes' recommendation | Sources | Ruled |
|---|---|---|---|---|---|
| DR-1 | One focus ring? A focused button draws two rings (the global halo plus its own outline), the graph node card draws two, `--focus-ring` is defined twice with different values and misused as an outline value, and the rail clips the ring. | (a) the global ring only, one token value; (b) keep the component outlines | (a) | PRIMITIVES PR23 and "Shared state rules"; TOKENS handback (`tokens.css:115`, `hub-ds/radius.css:38`, `app.css:862`, `:1030`, `:1038`); TASK-PAGE DS-TASK-13; SIDEBAR DS-SIDE-D8 | decided: one global focus ring, one token value, component outlines dropped (DIRECTION no-duplicates; PR23). |
| DR-2 | Interactive cards lift 1px on hover (`.card--interactive`, live on Track record) while other doors only change border. Lift everywhere or nowhere? | (a) nowhere, border only; (b) everywhere | (a), both lanes | PRIMITIVES PR17; COMPOSITES R6 | decided: border-only hover, no lift (both lanes; one hover rule). |
| DR-3 | One dock panel head and one close? The AI panel builds its own head (`.aip__*`); "close" has three dialects (panel X to `--text`, AI close to `--accent` with a 90° rotate at ≤ 900, Close all red). | (a) one head and one close with `--text` hover, Close all may stay red; (b) keep the AI head | (a); COMPOSITES would keep the rotate only in the ≤ 900 sheet | SIDEBAR R-SIDE-8; COMPOSITES R14 and the retired DS-COMP-21 drift | decided: one panel head per WIRING section 34.3 for every panel incl. the assistant; X hovers `--text`, no rotate; Close all stays red. |
| DR-4 | The menu surface: border `--accent` (as measured on `.sel__menu`) or `--border-strong` with accent only on the trigger? And is the in-flow booking pop `.bkpop` a variant or drift? | (a) `--border-strong`, drop `.bkpop` into the menu (PRIMITIVES); (b) accent border, keep `inline pop` (COMPOSITES) | Split: raised at consolidation when DS-COMP-24 became an alias of DS-PRIM-19 | PRIMITIVES DS-PRIM-19 drift; retired DS-COMP-24 | decided: menu border accent as drawn; `.bkpop` is DS-PRIM-19's in-flow placement (C109; WIRING.md:3136). |
| DR-5 | `.hint`, the accent-wash aside for the agent: a banner variant, or dropped into the info banner? | (a) keep as a DS-PRIM-22 variant; (b) drop into `.banner--info` | Split: PRIMITIVES (a), COMPOSITES (b) | PRIMITIVES PR18; COMPOSITES DS-COMP-5 drift | decided: `.hint` is a named DS-PRIM-22 variant (agent aside), not folded into info (PR18). |
| DR-6 | Number and headline roles: five are set in Funnel Sans instead of Display, and the task run hero's numbers are Chivo Mono 20 with no canonical style. | (a) Display for every number and headline role; (b) keep the Sans and mono roles as named styles | (a) for TOKENS; TASK-PAGE asks for a ruling on the mono numbers | TOKENS R-TOK-7; TASK-PAGE DS-TASK-4 and section 6 | decided: five Sans number/headline roles to Display (R53); task hero mono 20 kept as a named style (DIRECTION, task page as drawn). |
| DR-7 | Figures beyond the display scale: the portal hero's 128px number and 49.6px name, and the Weekly report's Display 128 scene number (WK-10). | (a) hero-only exceptions owned by the hero component (DS-COMP-31); (b) snap to the scale | (a), both lanes | TOKENS R-TOK-8; PRIMITIVES PR19 | decided: hero-only exceptions owned by DS-COMP-31 (both lanes; R53 named exceptions). |
| DR-8 | Rail widths: the DS tokens say 220 / 58, the mockup builds 224 / 56 (and `--sidebar-w`, `--sidebar-collapsed-w` are unused). | (a) 224 / 56 as built, update the tokens; (b) 220 / 58 | (a) | SIDEBAR R-SIDE-12 and its TOKENS hand-on | answered: rail 224 / collapsed 56 as built, tokens updated; settled as R54 (the owner, C109 and C121-1). |
| DR-9 | A 3px left rule marks a state where every tip strip uses 2px: `.chanflag`, `.draftgate`, the Activation map reader, and the gate card `.gate` (DS-TASK-7, AG-C56). | (a) 2px everywhere; (b) 3px as the "state" rule, 2px for tips | Split: COMPOSITES R4 says 2px for the flags, R17 keeps 3px for the map reader; TASK-PAGE leaves the gate open | COMPOSITES R4, R17, DS-COMP-5 drift; TASK-PAGE DS-TASK-7 drift | decided: 3px = state rule, 2px = tip/flagged card; all four drawn 3px rules stay (as drawn; DIRECTION task page). |

**One lane each** (DR-10 onward), in lane order.

| DR | Question | Options | Lanes' recommendation | Sources | Ruled |
|---|---|---|---|---|---|
| DR-10 | Dark faint text: `--ink-faint` (46%) and `--text-muted` (55%) are one value in light and split in dark. | one token at 55%; keep two dark tiers | One token at 55% | TOKENS R-TOK-1 | decided: `--ink-faint` folds into `--text-muted` at 55% in both themes (R-TOK-1; no duplicates). |
| DR-11 | Accent washes at 4, 6, 8 and 14%. | one `--accent-wash` at 8%; keep a strong 14% too | One at 8% (see DR-43 for where a wash is used) | TOKENS R-TOK-2 | decided: one `--accent-wash` at 8% (R-TOK-2; no duplicates). |
| DR-12 | Section heads (28) are larger than the page title (24). | keep; swap so the title leads | Keep | TOKENS R-TOK-3 | decided: keep section head 28 over page title 24, as drawn (C109; R-TOK-3). |
| DR-13 | `--fs-lead` 18px beside `--text-h2` 20px. | fold 18 into 20; keep both | Fold | TOKENS R-TOK-4 | decided: `--fs-lead` folds into `--text-h2` 20 (R53). |
| DR-14 | Reading line heights 1.45, 1.5, 1.6 and 1.7 beside 1.55. | one 1.55; keep several | One `--leading-normal` 1.55 | TOKENS R-TOK-5 | decided: one reading line height, 1.55 (R53). |
| DR-15 | `--dur` 180ms and `--dur-1` 220ms, both used. | keep both (colour, movement); fold to 200 | Keep both | TOKENS R-TOK-6 | decided: keep `--dur` 180 (colour) and `--dur-1` 220 (movement) (R-TOK-6). |
| DR-16 | New half steps `--s-0-5` 2px and `--s-1-5` 6px for dense UI (258 literal uses). | add both; snap to the scale | Add both | TOKENS R-TOK-9 | decided: add `--s-0-5` 2px and `--s-1-5` 6px (R-TOK-9). |
| DR-17 | A nine-layer z-index ladder replacing 17 literal values. | adopt; keep literals | Adopt | TOKENS R-TOK-10 | decided: adopt the nine-layer z ladder (R-TOK-10; CD-1 mechanism). |
| DR-18 | `--rail-bg` is ΔE00 1.6 from `--bg` in light. | keep the rail as its own plane; fold | Keep | TOKENS R-TOK-11 | decided: keep `--rail-bg` as its own plane, as drawn (R-TOK-11). |
| DR-19 | The `.sb` layer at z 72 sits two above the AI panel (70). | fold into `--z-panel`; keep | Fold. Consolidation note: the fixed `.sb` rule is dead (the task body mounts in the dock), so this may be moot | TOKENS R-TOK-12; TASK-PAGE defect row 43 | decided: no `.sb` layer; the dead fixed-drawer rule is not built (TASK-PAGE defect 43). |
| DR-20 | The toggle button (pressed = ink fill): a button variant, or folded into the segmented control? | secondary `pressed`; fold into DS-PRIM-10 | Keep as secondary `pressed` | PRIMITIVES PR1 | decided: toggle = secondary `pressed` variant of DS-PRIM-1 (PR1). |
| DR-21 | A 38-tall button size to pair with inputs (six places stretch a button to 38)? | add `md`; no | Add `md` | PRIMITIVES PR2 | decided: add button size `md` 38 (PR2). |
| DR-22 | Primary disabled: outline (live) or grey fill (hub)? | outline; fill | Outline | PRIMITIVES PR3 | decided: primary disabled is an outline (live mockup; PR3). |
| DR-23 | Keep a 22 compact icon button for dense rows? | yes; one size | Yes | PRIMITIVES PR4 | decided: keep the 22 compact icon button (PR4). |
| DR-24 | Keep hover-reveal controls (hidden until row hover)? | yes; always visible | Yes, but visible on touch and on focus. TICKET-PLAN R37 (decided) already shows them at rest below 900 | PRIMITIVES PR5 | decided: hover reveal kept above 900, at rest below 900 (R37), visible on focus. |
| DR-25 | Field ground: paper everywhere, or `--surface-2` on the client face? | one paper ground; two | Paper, one ground | PRIMITIVES PR6 | decided: one paper field ground on both faces (PR6; no duplicates). |
| DR-26 | Task brief textarea in mono on the panel and sans on the page? | mono in both; sans in both | Mono in both. TICKET-PLAN R60 (decided): the description is sans everywhere and mono stays only for the Agent brief, which answers this | PRIMITIVES PR7 | decided: already R60, sans description, mono only for Agent MD. |
| DR-27 | Switch "on" knob: `--success` fill, or an ink knob with a success border? | ink knob, success border; fill | Ink knob, success border | PRIMITIVES PR8 | decided: switch on = ink knob, success border (house no-fill rule; PR8). |
| DR-28 | Two pressed looks (ink fill for view switches, accent outline for filters). | keep both, named; one | Keep both | PRIMITIVES PR9 | decided: two named pressed looks, view switch ink, filter accent outline (PR9). |
| DR-29 | Chips are square in the dock and pills elsewhere. | pills everywhere; square everywhere | Pills | PRIMITIVES PR10 | decided: chips are pills everywhere (house rule; PR10). |
| DR-30 | Keep the dashed "pin" chip and the square `.vaultpill`? | drop both; keep | Drop both | PRIMITIVES PR11 | decided: `pinChip` and `.vaultpill` fold into the outline chip, content kept (PR11). |
| DR-31 | Keep the badge as its own component, or fold it into marker and count? | fold; keep DS-PRIM-12 | Fold | PRIMITIVES PR12 | decided: DS-PRIM-12 badge folds into marker and count (PR12). |
| DR-32 | Counts: square (live) or pill (DS)? | square; pill | Square | PRIMITIVES PR13 | decided: counts are square (live; WIRING.md:5791). |
| DR-33 | One status tone vocabulary (ok, run, gate, warn, bad, idle) replacing `is-*` and `data-tone`? | yes; no | Yes | PRIMITIVES PR14 | decided: one tone set ok/run/gate/warn/bad/idle (PR14; CD-1 naming). |
| DR-34 | People round, clients square? | yes; one shape | Yes | PRIMITIVES PR15 | decided: people round, clients square, as drawn (PR15). |
| DR-35 | Keep the accent-left-rule card (`--flagged`) for AI and recommendation cards? | yes, 2px; no | Yes, 2px | PRIMITIVES PR16 | decided: keep `--flagged` card, 2px accent rule (PR16). |
| DR-36 | A section at zero: removed (five places) or always an empty state? | always show; remove | Always show | PRIMITIVES PR20 | decided: sections always show, with an empty state at zero (PR20; WIRING section 34). |
| DR-37 | Adopt the three proposed loading patterns (none exists)? | adopt; other | Adopt | PRIMITIVES PR21 | decided: adopt PRIMITIVES' three loading patterns for DS-PRIM-29 (PR21). |
| DR-38 | Row error notes in `--text-2` rather than red? | `--text-2`; red | `--text-2` | PRIMITIVES PR22 | decided: row error notes in `--text-2` (PR22). |
| DR-39 | Two page-title insets (x 272 on designed client pages, 256 elsewhere). | one inset; keep both | One | COMPOSITES R1 | decided: one page-title inset, 256 (R1). |
| DR-40 | Portal Connections has no in-page title and Book has no sync marker. Intended? | follow the page as drawn; add them | As drawn | COMPOSITES R2 | decided: as drawn, no title on Connections, no sync marker on Book (R2). |
| DR-41 | Monthly chapter titles at Display 36 and Weekly bare u-tag heads: a report variant of the section head, or the numbered head? | report variant; numbered head | Report variant | COMPOSITES R3 | decided: report variant of the section head (R3). |
| DR-42 | The verdict strip and attention feed carry a stronger `--border-strong` outline than a card. | keep; card border | Keep | COMPOSITES R5 | decided: keep `--border-strong` on verdict strip and attention feed (R5). |
| DR-43 | Notification rows wash accent 6% on hover where other rows use `--surface-2`. | accent wash for notices only; one hover | Keep for notices only | COMPOSITES R7 | decided: notices hover with `--accent-wash` (8%); other rows `--surface-2` (R7). |
| DR-44 | Three fold rules for long lists (fold at 8, page by 10, no fold). | one rule, to be chosen | One rule (which is open) | COMPOSITES R8 | behaviour: long lists fold at 8 / ledgers page by day, tracked per list type (R49); do not copy the whole 170-row ledger. |
| DR-45 | Two chat renderers (people thread and assistant bubbles). | keep both; one | Keep both | COMPOSITES R9 | decided: people thread and assistant bubbles kept as named variants (R9). |
| DR-46 | The Activation map's legend doubles as a status filter where other pages use facets. | keep there; facets | Keep | COMPOSITES R10 | behaviour: legend click filters the Activation map by status, tracked in the page's filter state. |
| DR-47 | CRM board actions on a second line. | keep; one line | Keep | COMPOSITES R11 | decided: CRM board actions stay on a second line (R11). |
| DR-48 | Board row height 39 (projects) against 43 (CRM), name weight 400 against 500. | one height and weight; keep both | One of each (values open) | COMPOSITES R12 | decided: board rows 39 tall, names 400 (Projects board; R12). |
| DR-49 | Review cards go to one column at ≤ 900 on the agency twin and at ≤ 1279 on the portal. | one breakpoint; keep both | One (value open) | COMPOSITES R13 | decided: review cards go single column at ≤ 900 on both faces (R13). |
| DR-50 | The voice note form has no tinted block. | tinted block; as drawn | Tinted block | COMPOSITES R15 | decided: voice note form gets the tinted block (R15). |
| DR-51 | The response-time sparkline is drawn without an area. | area on; off | Area on | COMPOSITES R16 | decided: sparkline area on everywhere (R16). |
| DR-52 | Report widths 880, 940 and 960. | one width, to be chosen | One (value open) | COMPOSITES R18 | decided: one report width, 960 `.content--narrow` (R18). |
| DR-53 | There is no modal: are inline confirms the house pattern, or should a modal exist? | inline confirm; add a modal | Inline confirm | COMPOSITES R19 | decided: inline confirm, no modal (the owner's alert ruling WIRING.md:3567; R19). |
| DR-54 | Every section needs an icon in the collapsed rail: key the icons by route id in `routes.json`, not by path? | by route id; by path | By route id | SIDEBAR R-SIDE-1 | behaviour: collapsed-rail icon per section, tracked as an icon field keyed by route id; do not copy the blank rail. |
| DR-55 | Should the rail drawer's close slide out, and should the drawer be modal (focus in, trap, return)? | yes to both; either; neither | Yes to both | SIDEBAR R-SIDE-2 | decided: the rail drawer slides out on close (R-SIDE-2). Focus trap goes to the placeholder register. |
| DR-56 | Rail drag: follow the cursor live and save on release? Snap to collapsed under 170? | live and save on release, no snap; other | Live, save on release, no snap | SIDEBAR R-SIDE-3 | behaviour: rail width drag, live follow, saved on release as a per-person preference replayed before paint (section 34.4). |
| DR-57 | Keyboard: a rail collapse shortcut, keyboard resizing for both grips, and one layered Escape that never fires from inside an input? | yes; as drawn (no shortcuts) | Yes | SIDEBAR R-SIDE-4 | behaviour: keyboard collapse shortcut, keyboard resize on both grips, one layered Escape; interaction only. |
| DR-58 | Only a seated panel glides; a floating one appears with no motion. | keep; add motion | Keep | SIDEBAR R-SIDE-6 | decided: floating panels appear without motion, as drawn (WIRING.md:1412-1416; R-SIDE-6). |
| DR-59 | WIRING §34.1's rail order has no Notifications; `ORDER` puts it second. Update the law? | update the law; change the build | Update the law | SIDEBAR R-SIDE-7 | decided: rail order CI, Notifications, Team, Clients, Projects, Task, Bookmarks, Docs (WIRING section 63.2; #121). |
| DR-60 | Back to Clients: keep it a filled primary button, make it an anchor, show a back icon when collapsed? | yes; other | Yes | SIDEBAR R-SIDE-9 | decided: Back to Clients stays filled primary; collapsed rail shows a back icon (R-SIDE-9). Anchor semantics go to the register. |
| DR-61 | The fold button overlaps the end of the wordmark at 224. | move it clear; as drawn | Move it clear | SIDEBAR R-SIDE-10 | decided: fold button moved clear of the wordmark (defect; R-SIDE-10). |
| DR-62 | The railmark slides in 220 ms and the tab underline in 420 ms. | keep both; one speed | Keep both | SIDEBAR R-SIDE-13 | decided: keep 220ms railmark and 420ms underline (R-SIDE-13). |
| DR-63 | The task page draws the task name twice (the topbar title and the record title). | keep both; one | Flagged as possibly deliberate, no recommendation | TASK-PAGE DS-TASK-11 | answered: task name shown in topbar and record header, as drawn (DIRECTION.md:9, task page built as in the mockup). |

**Raised by the Astra cross-check** (27 September; `ASTRA-CROSSCHECK.md`), both ruled by the owner's answers of 27 September:

| DR | Question | Options | Recommendation | Sources | Ruled |
|---|---|---|---|---|---|
| DR-64 | Seating order: when the panels you asked for do not fit beside the 836 floor, do they narrow towards 380 first and then float (WIRING §34.4, written 30 July), or float at the width you asked for (the code, from your 28 July "I'm liking how you've got that overlay")? R39 settled the floor and the third-panel close, not this. | (a) float at the width asked for, and amend §34.4; (b) narrow to 380 first, then float | (a): it is your later-dated spoken ruling, and seating on the minimum made a drag unable to reach the width it showed | `dock.js:258-273` (commit `3abbe90`, 28 Jul); `WIRING.md:2222-2224` (commit `0fa736c`, 30 Jul); Astra sidebar question 1; SIDEBAR DS-SIDE-7 drift | answered (a) by the owner, 27 September (`CAPABILITY-SLICES.md`, "Owner answers" item 8): float at the width asked for; WIRING §34.4 is amended by a note in `SIDEBAR.md` (T-D19 and the DS-SIDE-7 drift note). |
| DR-65 | Small status text: the light info, success, warning and danger colours fail contrast as 12 to 13 px text on white (3.00, 2.54, 2.15 and 3.77 to 1). Keep one colour per status, or add darker light-theme text variants and keep the current colours for lines, rules and icons? | (a) add text variants (for example #0076b0, #047857, #92400e, #be123c); (b) keep the drawn colours | (a), light theme only; dark already passes | TOKENS DS-TOK-21 to DS-TOK-24; Astra catalogue question 3 | answered (a) by the owner, 27 September (`CAPABILITY-SLICES.md`, "Owner answers" item 9): darker light-theme text variants for small status text; the drawn colours stay for lines, rules and icons; dark unchanged (`TOKENS.md`, DS-TOK-21 to DS-TOK-24). |

**Ticket-plan rulings that change the look** (closed tickets #298 to #306 and #331 on the map "Ops Astro design system"). Each is written into the file named; `evidence/BUILDREADY.md` has the record.

| Ruling | What the build draws | Where it is written |
|---|---|---|
| NEW-298 Which edge is "the sidebar" | The dock is the reference; the left rail is specified to the same standard | `SIDEBAR.md` ("Which edge is the sidebar: decided") |
| TICKET-PLAN R52 Fonts and icons (#299, #331) | The three OFL fonts ship with their licence files; icons swap to an open-licence set (MIT, ISC or Apache, for example Lucide, Tabler or Phosphor) drawn to match the regular rounded style | DS-PRIM-17; this file, "The token file" |
| TICKET-PLAN R53 Type scale | The measured styles snap to the canonical scale; exceptions are named (DR-6, DR-7) | `TOKENS.md` (census rulings note) |
| TICKET-PLAN R54 Shell dimensions | Rail 224, collapsed 56, chrome 45 + 43 + 59 | `TOKENS.md` DS-TOK-88, DS-TOK-89; `SIDEBAR.md` (DR-8) |
| TICKET-PLAN R55 Collapsed-rail icons | One icon per section, the seven missing glyphs named in one pass, keyed by route id (DR-54) | `SIDEBAR.md` T-R4, DS-SIDE-D1; `PLACEHOLDERS.md` |
| TICKET-PLAN R56 and R13 Unavailable, not-connected and mock | Disabled with its reason; "Not connected: <dependency>"; the mock mark DS-PRIM-32 on a demo install only | DS-PRIM-32; `TASK-PAGE.md` section 1; `PLACEHOLDERS.md` |
| TICKET-PLAN R33, R37, R39 The dock at narrow widths | A visible strip at rest below 900 and one panel as a sheet; hover reveals at rest below 900; the 380 floor and the third-panel close | `SIDEBAR.md`; DS-PRIM-2 (DR-24) |
| TICKET-PLAN R40, R60 Task page | Tags, page link and pin as drawn; description sans, mono only for the Agent brief | `TASK-PAGE.md` section 1; DS-PRIM-4 (DR-26) |
| TICKET-PLAN R47, R48, R59, R62 Boards and tabs | Cell editor inside the row height; the scope chip is a fixed label; four stages across at 900; the tab row scrolls with a fade and arrows | DS-COMP-17, DS-COMP-16, DS-COMP-19, DS-COMP-2 |
| TICKET-PLAN R57, R58 Charts | Value tooltips on hover and focus (behaviour); managed spend on its own right-hand axis | DS-COMP-27 |
| TICKET-PLAN R61 Section numbers | Numbers read top to bottom on each page and face | DS-COMP-4 |
| TICKET-PLAN R63 Execution graph connector | No style picked: the graph is catalogued as drawn (Rail, for reference) and marked likely replaced, tied to the harness decision; no connector work | `TASK-PAGE.md` DS-TASK-12 to DS-TASK-14 |
| TICKET-PLAN R77 Timer on panel close (behaviour) | Stop the timer and log the time; built in the Tasks phase, outside the T1 demo | `PLACEHOLDERS.md`, "Behaviour decided"; `TASK-PAGE.md` section 1 |

**Ticket-plan rulings, pass 2** (27 September, lane RULINGS-TP; the 34 that `PLACEHOLDERS.md` cited as open). Each outcome is written into the register's source cells. The evidence per ruling is in `evidence/BUILDREADY.md` "Pass 2". Decided rows are the owner's to veto, and need no answer.

| Ruling | Outcome | Source |
|---|---|---|
| TICKET-PLAN R3 The mockup's launcher page (`/index.html`) | decided: No launcher page in the product: `/` goes to `/dashboard/`; the 22 cards stay a mockup index. | docs/design-system/DIRECTION.md:17; docs/mockup-inventory/SHELL.md |
| TICKET-PLAN R4 The task page address | decided: The task page lives at Ops Astro's `/task/:key`; the mockup's `/agency/task/?task=<id>` is recorded as superseded. | docs/authority.md:13; PLACEHOLDERS.md DP-05 |
| TICKET-PLAN R5 Canonical addresses only, everywhere | decided: One route table maps every legacy `/agency/…` and `/client-portal/…` link to its canonical address; stored addresses are canonical; internal pages link to `/clients/:client/…` and a deliberate crossing to the client's view goes to `/portal/:client/…`. | docs/decisions/product-and-identity.md:9; docs/authority.md:13 |
| TICKET-PLAN R6 The agency Projects tabs: Reviews and the Work log | decided: The Reviews tab shows the Review twin at `/projects/reviews/` (the `#review` hash retires) and a third tab, Work log, shows the agency ledger. | CAPABILITY-SLICES.md:607 |
| TICKET-PLAN R7 What `/inbox/` is | decided: `/inbox/` is the dock Notifications list in full-page form: one store, no second queue. | docs/roadmap.md:62; CAPABILITY-SLICES.md:596 |
| TICKET-PLAN R8 The Clients board: tabs and shape | answered (split: part decided): The CRM board takes the command bar (the owner's Variant A) with Needs attention and Needs response as pinned chips (answered); Clients, Leads and People waiting become tab-row entries (decided). | WIRING.md:14379; CAPABILITY-SLICES.md:606 |
| TICKET-PLAN R9 The client workspace's Reviews tab on the agency side | decided: Keep the client's split cards on the agency side (the agency sees what the client sees), with the three defects fixed; client writes are drawn disabled there. | docs/design-system/DIRECTION.md:9; triage/triage.json R18 |
| TICKET-PLAN R10 What the Docs addresses are | decided: `/clients/:client/docs/` is the agency side of the one designed Docs page (shared documents, page copy and compliance, asset doors); shared, favourites and trash wait for the Docs engine; the dock Docs panel links out to its scope's Docs page; `/docs/` and `/docs/snippets/` follow R2. | docs/roadmap.md:47; triage/triage.json R2 |
| TICKET-PLAN R11 What Forms is | decided: `/clients/:client/forms/` is a directory of the client's forms with a per-form Submissions view; the editor and embed pages come with the Forms build to the roadmap's forms contract; the workbench Forms tab gets a source key and stays hidden until connected; the portal Contact page lists the same directory. | WIRING.md:1019; docs/decisions.md:30 |
| TICKET-PLAN R12 Workbench tabs that can never appear | decided: Forms, Testing and Revenue get an explicit source key in the one source-to-tab map and Google Business Profile maps to Local, each hidden until its source is connected; their designs stay specified. | docs/roadmap.md:68; CAPABILITY-SLICES.md:643 |
| TICKET-PLAN R15 Where the Activation map is reached from | decided: Doors from the client Brief and the Growth roadmap header, both with the in-app arrow mark. | CAPABILITY-SLICES.md:615 |
| TICKET-PLAN R19 Whether a client ever sees the channel workbench | decided: Agency-only in version one; clients see figures through published reports; a per-tab exposure toggle is later work. | CAPABILITY-SLICES.md:645; docs/roadmap.md:70 |
| TICKET-PLAN R20 The dock's Portal door on a client | decided: Every client's Portal door opens their workspace with the home icon; WIRING §92.1's flagship-only split is corrected. | WIRING.md:14305; triage/triage.json R38 |
| TICKET-PLAN R22 Whether the client's project cards write | answered (part merged into owner answer 2): Yes: the client's people comment on and approve their own projects' cards, authorised per signed-in person on the server; comment and approve first, edit-own-comment second. What a client approval binds is owner answer 2: with the client's sign-off setting off, the press is the client's response feeding the agency's decision; with it on, it is the binding decision. | WIRING.md:16283; docs/decisions/product-and-identity.md:83 |
| TICKET-PLAN R23 Whether a client can see a report the agency has not shared | decided: No: the client sees only reports published with Share with client, and until then the last shared one. | docs/decisions/observability.md:9; WIRING.md:104 |
| TICKET-PLAN R24 Whether Request changes needs a reason | decided: Yes: Request changes opens the composer, as Let's discuss does, and the request is sent with the comment. | docs/decisions/execution.md:9; CAPABILITY-SLICES.md:632 |
| TICKET-PLAN R25 A client removing a connection | decided: A one-line inline confirm naming what stops working, then a few seconds of undo. | CATALOGUE.md DR-53 |
| TICKET-PLAN R26 Who may remove a voice note | decided: A client removes only notes they wrote; the agency's notes stay until folded into a lever. | WIRING.md:1019; triage/triage.json R42 |
| TICKET-PLAN R27 Booking a meeting: one component on both faces | answered (split: part decided): One quick event card on both faces replaces the portal's older booking page (answered); Guests default to the account lead by role, and Send is drawn unavailable until a calendar integration exists, never claiming an invite was sent (decided). Superseded in part by owner answer 15 and T2: Send books through the installation's Cal.com, which writes the event and sends the invite (CS-10.7). | WIRING.md:641; WIRING.md:691 |
| TICKET-PLAN R28 The ask sparkles and "Ask us" on the client's side | answered (split: part decided, part merged into owner answer 6): No sparkles on the client face: no agent conversation reaches the portal in version one (answered); Ask us opens Contact's ticket form with the page named in the subject (decided); the ticket lands as a task under the client's standing Requests project, promoted to its own project when it grows into work (owner answer 6). | docs/decisions/product-and-identity.md:83; CAPABILITY-SLICES.md:629 |
| TICKET-PLAN R32 "Talk about your plan" on the agency side | decided: Hidden on the agency face; it is the client's route to the agency. | triage/triage.json R18; PLACEHOLDERS.md FA-CLIENT-85 |
| TICKET-PLAN R35 Reordering bookmarks | decided: No reorder in the first build; add it if the list grows past a screen. | CAPABILITY-SLICES.md:627 |
| TICKET-PLAN R46 Board typeahead matching | decided: Match on word starts. | docs/mockup-inventory/BOARDS.md:494 |
| TICKET-PLAN R50 The Search intent build console and the Google Ads run rail | decided: The console's live controls are deferred; the rail and console ship read-only only if the agent executor lands in the same release. | WIRING.md:1102; CAPABILITY-SLICES.md:642 |
| TICKET-PLAN R64 Every figure derives from the records it describes | decided (part merged into owner answer 5): No typed figure ports: targets come from the goals form, business details from the client record, counts from the rows they count; controls that need absent data render unavailable. Invoice figures read from Xero through the installation's Xero connector (owner answer 5). | docs/design-system/DIRECTION.md:13; docs/roadmap.md:68 |
| TICKET-PLAN R66 The Brief's fourth verdict row | answered: Website visits, as the data says; WIRING §30's "Revenue booked" is corrected. | dashboard-mockups commit da23958; WIRING.md:1818 |
| TICKET-PLAN R67 One brand record per client | decided: One per-client brand record (logos, palette, typefaces, hero media, gallery), with the design-system export as the palette's source, read by Brand, the Design system and the portal Home gallery. | docs/design-system/DIRECTION.md:9; WIRING.md:1038 |
| TICKET-PLAN R68 The Drive tab | answered by owner answer 4: production files live in the client's Drive, so the tab becomes a real listing of the read-only Drive mirror (C63) whose tiles open through the app; until the mirror is built the tab is removed and "things that live elsewhere" go through the Docs asset doors. | docs/design-system/CAPABILITY-SLICES.md (Owner answers, item 4; CS-12.10, CS-16.13) |
| TICKET-PLAN R69 Growth roadmap before the goals form exists | decided: The tab shows an honest empty state until the goals form writes roadmap items; the typed indicative roadmap never ports. | docs/roadmap.md:70; triage/triage.json R65 |
| TICKET-PLAN R70 The derived task rank | decided: A read-only derived rank with its calc line and the priority and age modifiers; the board's Rank column uses it; the hand-set board order is "position". | CAPABILITY-SLICES.md:586; docs/build-plan.md:188 |
| TICKET-PLAN R71 Linking a task to the grant it runs under | decided: An explicit field set by the broker, so the scope stamp names the grant. | docs/decisions.md:36; triage/triage.json R76 |
| TICKET-PLAN R72 The Projects board's columns | answered: Drop the State column Ops Astro added (status is the group banner) and add the Client comments column. | WIRING.md:2912; WIRING.md:11110 |
| TICKET-PLAN R74 The Calls tab | decided: Calls stays out of the first build wave and appears when a call-tracking connector is chosen and connected. | docs/roadmap.md:68 |
| TICKET-PLAN R75 One vocabulary for prediction outcomes | decided: Prediction met / Below prediction / Missed, with Measuring for a running row, on Monthly and Track record alike. | docs/mockup-inventory/CLIENT.md:289 |

## Counts

- **Canonical components: 98** since AUDIT-RECONCILE (27 September) retired DS-PRIM-8 Radio, DS-COMP-36 Placeholder page and DS-COMP-41 Rank grid (alias table): DS-PRIM 31 (of 33 ids), DS-COMP 37 (of 41 ids), DS-SIDE 18, DS-TASK 12. Before that: **101.** DS-PRIM 32 (of 33 ids), DS-COMP 39 (of 41 ids), DS-SIDE 18 (of 19), DS-TASK 12 (of 15). DS-PRIM-12 Badge folded into DS-PRIM-25 and DS-PRIM-13 at build-ready (DR-31); before that the count was 102. RECONCILE-LOOK added DS-PRIM-33 Locate flash, DS-COMP-40 Funnel chart and DS-COMP-41 Rank grid on 27 September. Three were added by the Astra cross-check on 27 September: DS-PRIM-32 Mock-data mark, DS-COMP-38 Calendar and date grid, DS-COMP-39 Media tile. Two of the 96 are recorded gaps with nothing drawn (DS-PRIM-8, DS-PRIM-29) and one is a cross-reference table (DS-COMP-35).
- **Ids issued: 108** (33 + 41 + 19 + 15; the lanes issued 102, the Astra cross-check 3, RECONCILE-LOOK 3). **Aliases: 7 whole ids** (DS-COMP-21, DS-COMP-24, DS-SIDE-16, DS-TASK-2, DS-TASK-8, DS-TASK-15, and DS-PRIM-12 by DR-31) and **4 parts of entries** (the `.cmtabs` usage in DS-PRIM-10, `.gate` in DS-COMP-5, the panel search row in DS-COMP-22, the DS-TASK-5 toggle). One entry corrected (DS-COMP-25, the `.sb` drawer).
- **Variants kept: 264** across the 98 since AUDIT-RECONCILE (DS-COMP-38 drops `day list` and `meeting-type tile` under R27; DS-COMP-36 and DS-COMP-41 retire one each). Before that: **268** across the 101 (unchanged at build-ready: DR-21 adds `md` to DS-PRIM-1, DR-25 drops `--sunk` from DS-PRIM-3, and DR-31 moves DS-PRIM-12's two variants into DS-PRIM-25 and DS-PRIM-13); 268 across the 102 before that (264 before, plus 1 + 2 + 1 for DS-PRIM-33, DS-COMP-40 and DS-COMP-41); the 264 was counted across the 99 (254 across the first 96, plus 3 + 5 + 2 for the three added ids), by this index's reading (see Known gaps).
- **Tokens: 132** DS-TOK ids in `TOKENS.md` (109 tokens, 23 text styles; DS-TOK-130 to DS-TOK-132 added by the cross-check).
- **Page map: 1,305 element rows**, 1,272 mapped to a component, 33 to `content`, 0 unmapped (`PAGE-MAP.md`; AUDIT-RECONCILE moved LR-W03 to `content`, eight undesigned addresses to DS-PRIM-28 and PB-04, PB-06 to DS-PRIM-5); five retargeted by RECONCILE-LOOK (PB-04, PB-06, PB-07 to DS-COMP-38; FN-W02 to DS-COMP-40; LR-W03 to DS-COMP-41), plus 167 fresh-audit rows mapped outside these figures.
- **Rulings: 65** `DR` ids, all ruled and applied: 63 by the lanes (2 answered, 56 decided, 5 behaviour; DR-3, 6, 9, 53, 55 and 60 split) and 2 by the owner's answers of 27 September (DR-64, DR-65, raised by the Astra cross-check), gathered from 69 lane questions (TOKENS 12, PRIMITIVES 23, COMPOSITES 19, SIDEBAR 11, TASK-PAGE 4) plus 1 raised at consolidation (DR-4).
- **Ticket-plan rulings: 75 considered.** 41 triaged on this map (#298 to #306, #331) and applied at build-ready; 34 triaged in pass 2 (6 answered, 27 decided, 1 merged into the owner's list); R1 and R68 were answered by the owner (items 1 and 4).
- **Shots:** 1,140 PNG under `shots/` (1,116 from the lanes, 14 added by the Astra cross-check for DS-COMP-38, DS-COMP-39 and DS-PRIM-32, and 10 added at build-ready for DS-PRIM-33, DS-COMP-40 and DS-COMP-41) (tokens, prim, comp, sidebar, task). Every shot path linked from the catalogue files resolves to a file (0 broken), and every file under `shots/` is linked from somewhere (0 orphans): the 18 shots of the three retired entries are linked from "Carried from retired entries" above, and the 54 motion key frames under DS-SIDE-11 and DS-SIDE-14 that were linked only through their contact strips are now linked by folder there too. Checked at consolidation by script, not by eye, and again at build-ready (1,140 files, 0 broken links, 0 orphans by file or folder).

## Known gaps

- **Date-picker calendar grid, week strip and slot grid** now have an id, DS-COMP-38 (added by the Astra cross-check, with shots of the week strip, day list, slot grid and meeting-type tiles). The open date picker and the mock mark's word chip are still not cropped.
- **DS-PRIM-29 Loading** is a gap (nothing drawn). It stays so the build has a home for it. DS-PRIM-8 Radio was retired on 27 September (no use). DS-PRIM-21 Card (base) is a target of no row by design: the card composites are built on it.
- **Page-local charts.** The geo-grid LR-W03 and the true-scale funnel FN-W02 have their own ids since 27 September (DS-COMP-41, DS-COMP-40), with shots since build-ready (their tabs are hidden for the sample tenant, so the crop re-renders the page without its source pruning). The rank grid's legend is not cropped. The account bar AC-02 still maps to DS-COMP-29 as the nearest fit.
- **DS-PRIM-33 Locate flash** has still shots of its first key frame since build-ready; no motion strip of the 1.5 s fade.
- **Ticket-plan rulings, pass 2.** The 34 (TICKET-PLAN R3 to R75) that `PLACEHOLDERS.md` cited as open were triaged on 27 September (lane RULINGS-TP): 6 answered, 27 decided, and R68 merged into the owner's item 4, answered on 27 September; see "Ticket-plan rulings, pass 2" above. Decided outcomes stand unless the owner vetoes one.
- **Variant counts** above are this index's reading of each entry's "Variants kept"; lane handbacks counted variant shot slots, which include named parts and drift shots, so the totals differ.
- **Usage lists inside the lane files** still name both a host part and the primitive it is built on in some places; `PAGE-MAP.md` is the one place where each element has exactly one target.
