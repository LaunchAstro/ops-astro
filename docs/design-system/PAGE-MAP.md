<!-- Public edition, generated from the private design-system source by ticket C82's build and checked by the real-names check before it crossed. Do not edit it here; the source changes and the copy is run again. Screenshots and review records stay private, so they are not linked. -->

# Page map: every inventory element to one component

Lane CONSOLIDATE, design-system pass wave 2, 26 September 2026. Ticket "Consolidate the catalogue and write the page map (#294)" on the map "Ops Astro design system". It answers to `DIRECTION.md`: "all of the different elements from each of the pages points to that one page". Plan and document only.

Each row of the eight page inventories in `docs/mockup-inventory/` points to exactly one canonical component id from `CATALOGUE.md`, or to `content` (copy, a data value, a behaviour or a wrapper with no look of its own) with the reason. Aliased ids (see the alias table in `CATALOGUE.md`) are never targets. Where an element is built from several components, the target is the component that *is* the element: a single control maps to its primitive, a region, card, row, strip or chart to its composite; the parts inside it are listed in that component's entry, not here.

## Coverage

- **Element rows: 1,305.** Mapped to a component: **1,272**. `content`: **33**. Unmapped: **0**. (27 September, AUDIT-RECONCILE: LR-W03 to `content` with DS-COMP-41 retired; the eight DOC and FM addresses from the retired DS-COMP-36 to DS-PRIM-28; PB-04 and PB-06 to the one booking card's selects, R27; the 167 fresh-audit rows are 139 to a component and 28 `content`.) (Updated 27 September by the Astra cross-check: SH-26 moved from `content` to DS-PRIM-32; DP-20b, BR-21, PH-10 and PH-19 moved to the new DS-COMP-38 and DS-COMP-39.)
- **Reconciled with the fresh audit, 27 September (lane RECONCILE-LOOK, #325).** Five inventory rows were retargeted: PB-04, PB-06 and PB-07 to DS-COMP-38 Calendar and date grid; FN-W02 to the new DS-COMP-40 Funnel chart; LR-W03 to the new DS-COMP-41 Rank grid. The 1,305 / 1,273 / 32 figures are unchanged by this (a retarget, not a new row). 167 elements the fresh audit found with no inventory row are mapped in "Fresh-audit elements with no inventory row" below, outside these figures. The execution-graph rows (S7) are marked likely replaced.
- Canonical components used as a target: 95 of the 102 canonical ids as counted before build-ready; DS-PRIM-12 Badge has since folded into DS-PRIM-25 and DS-PRIM-13 (DR-31), leaving 101 canonical ids, of which 95 are targets (DS-PRIM-32, DS-COMP-38 and DS-COMP-39 added by the Astra cross-check, 27 September; DS-COMP-40, DS-COMP-41 and DS-PRIM-33 by RECONCILE-LOOK, of which DS-PRIM-33 has no inventory row and is a target only in the fresh-audit section). Not a target of any row: DS-PRIM-8 Radio and DS-PRIM-29 Loading (gaps: nothing drawn), DS-COMP-35 Client face deltas (a cross-reference table, not a component), and DS-PRIM-9 Switch and DS-PRIM-21 Card (base) (and, before its fold, DS-PRIM-12 Badge), which appear only inside other components (for example the switch in AG-C51, the badge in AG-K10, the card under every DS-COMP-7).
- **What counts as an element row.** Every id row in an element table of the eight files: tables headed `id | Element` (1,115 rows), the Workbench `widget`, `component` and `chart` tables, the Boards column tables, the Client recommendation-card slots (RC) and placeholder addresses (DOC, FM), the Agency page kit (AG-K) and the Portal client-capability rows (PAI, PAH, PAD, PAP, PAS). Not counted: findings and defect tables (AGENCY D-A, BOARDS D and W, CLIENT CL-D and CL-I, PORTAL PF and PO, TASKS D, and every file's ticket and test tables), the route table AG-X1 to AG-X16, and SHELL section 1 (DS-C and DS-T are mapped in `TOKENS.md`, DS-K in `CATALOGUE.md`'s old-id map).
- **Against the 1,404 in `TICKET-PLAN.md`.** That figure is the eight inventory lanes' own tally. Counted by the rule above the files hold 1,305; adding the tables left out above (227 id rows) gives 1,532, so the lanes' rule sat between the two and is not recorded. The per-file counts below make the difference traceable.
- **Method.** Candidates came from every lane entry's Usages list (aliases resolved) and from `TASK-PAGE.md` section 3, whose first-named component was kept for the TASKS rows. Rows with several or no candidates were decided against the entries' anatomy by four sub-agents under one rule, then checked: every row appears once and every target is a canonical id. Two decisions were overridden at consolidation: AG-C56 to DS-TASK-7 (the gate card's one home) and SH-22 to DS-PRIM-25 (every sync marker is the freshness marker).

| Inventory | Rows | Mapped | content | Unmapped |
|---|---|---|---|---|
| `SHELL.md` | 47 | 43 | 4 | 0 |
| `DOCK.md` | 126 | 125 | 1 | 0 |
| `TASKS.md` | 120 | 120 | 0 | 0 |
| `BOARDS.md` | 153 | 148 | 5 | 0 |
| `AGENCY.md` | 196 | 184 | 12 | 0 |
| `CLIENT.md` | 171 | 166 | 5 | 0 |
| `WORKBENCH.md` | 362 | 359 | 3 | 0 |
| `PORTAL.md` | 130 | 128 | 2 | 0 |
| **Total** | **1,305** | **1,273** | **32** | **0** |

Prefix clashes, resolved 27 September (AUDIT-RECONCILE, OP-20): WORKBENCH's shared chrome is keyed `WSH-01` to `WSH-34` and TASKS' missing-task rows `TKM-01` to `TKM-04`, as in `PLACEHOLDERS.md`, so no id means two controls; SHELL keeps `SH-1` to `SH-47` and DOCK's Team panel keeps `TM-01` to `TM-06`.

## SHELL.md

### The app shell (every page)

| Id | Element | Component | Note |
|---|---|---|---|
| SH-1 | Rail | DS-SIDE-11 Navigation rail | expanded rail |
| SH-2 | Wordmark | DS-SIDE-12 Rail brand | wordmark |
| SH-3 | "HUB" label | DS-SIDE-12 Rail brand | HUB label under the wordmark (no candidate) |
| SH-4 | Rail item, one level | DS-SIDE-13 Rail item | one-level rail item |
| SH-5 | Hub rail sections | DS-SIDE-13 Rail item | the Hub item set |
| SH-6 | Railmark | DS-SIDE-14 Railmark | railmark |
| SH-7 | Rail fold | DS-SIDE-15 Rail fold button | rail fold button |
| SH-8 | Width grip | DS-SIDE-10 Panel width grip | shared width grip (rail grip alias resolved) |
| SH-9 | Collapsed rail | DS-SIDE-11 Navigation rail | collapsed 56px variant |
| SH-10 | Appbar | DS-COMP-1 App strip | app strip |
| SH-11 | Back | DS-COMP-1 App strip | back control of the app strip |
| SH-12 | Forward | DS-COMP-1 App strip | forward control of the app strip |
| SH-13 | Client identity (client pages only) | DS-COMP-1 App strip | client identity slot, client pages |
| SH-14 | Search box | DS-COMP-1 App strip | search slot (search box DS-PRIM-6) |
| SH-15 | Presence avatars | DS-COMP-1 App strip | presence slot (avatar stack DS-PRIM-16) |
| SH-16 | Face switch | DS-COMP-1 App strip | face switch slot (segmented DS-PRIM-10) |
| SH-17 | Start timer | DS-COMP-1 App strip | timer slot (bespoke button) |
| SH-18 | Tab row | DS-COMP-2 Tab row and tab mark | tab row |
| SH-19 | Tab underline | DS-COMP-2 Tab row and tab mark | tab mark underline |
| SH-20 | Page header | DS-COMP-3 Page header | page header |
| SH-21 | Placeholder chip | DS-PRIM-11 Chip and pill | outline chip in placeholder meta slot; chose chip |
| SH-22 | Sync marker (in the meta slot on designed pages) | DS-PRIM-25 Marker, tag, stamp, index and freshness | sync marker: freshness, as every other sync marker |
| SH-23 | Hamburger | DS-SIDE-17 Navigation toggle (hamburger) | navigation toggle |
| SH-24 | Drawer backdrop | DS-SIDE-18 Drawer backdrop | drawer backdrop |
| SH-25 | Dock rail (shell part only) | DS-SIDE-1 Dock edge rail | dock edge rail; tabs are DS-SIDE-2 |
| SH-26 | Dock count chip | DS-SIDE-4 Dock count chip | dock count chip |
| SH-27 | Tip banner dismiss (shell behaviour on page banners) | DS-PRIM-2 Icon button (including close ×) | banner dismiss close button |
### Client workspace sub-navigation (`/clients/:client/*`)

| Id | Element | Component | Note |
|---|---|---|---|
| SH-30 | "Back to Clients" | DS-SIDE-19 Client workspace group | back-to-clients button of the client group |
| SH-31 | Client sections | DS-SIDE-19 Client workspace group | client section items (DS-SIDE-13 dress) |
| SH-32 | Tab rows per section | DS-COMP-2 Tab row and tab mark | tab row per client section |
| SH-33 | Client identity | DS-COMP-1 App strip | client identity with AGENCY VIEW tag |
### Reserved-route placeholder (`/route-home/`), the placeholder-page pattern

| Id | Element | Component | Note |
|---|---|---|---|
| SH-40 | Page header | DS-COMP-3 Page header | placeholder variant: route label, placeholder chip |
| SH-41 | Info banner | DS-PRIM-22 Banner and tip | info banner, placeholder notice placement |
| SH-42 | "Route contract" heading | DS-COMP-4 Section head | unnumbered section head on placeholder page |
| SH-43 | Sibling cards | DS-COMP-8 Door card | door cards for sibling routes |
| SH-44 | Port handoff card | DS-COMP-7 Card (content and list card) | content card of tag rows |
### Launcher (`/index.html`)

| Id | Element | Component | Note |
|---|---|---|---|
| SH-50 | Page wrap | `content` | page-level wrapper, no look of its own |
| SH-51 | Eyebrow | DS-PRIM-25 Marker, tag, stamp, index and freshness | marker u-tag eyebrow |
| SH-52 | Hero title | `content` | launcher title copy, display type only |
| SH-53 | Lead | `content` | lead paragraph copy, type role only |
| SH-54 | Group heads | DS-COMP-4 Section head | group head: sec__meta tag and marker |
| SH-55 | Surface cards ×22 | DS-COMP-8 Door card | card door grid (a.vcard) |
| SH-56 | Notes | DS-COMP-7 Card (content and list card) | two content cards of annotation rows |
| SH-57 | Footer banner | DS-PRIM-22 Banner and tip | plain banner, footer notice |
| SH-58 | Theme toggle | `content` | no element drawn; missing control noted as defect |
### The theme switch

| Id | Element | Component | Note |
|---|---|---|---|
| SH-60 | Theme row | DS-COMP-13 List row | record row (.setrow) with segmented |
| SH-61 | Tips row | DS-COMP-13 List row | record row (.setrow) with segmented and button |

## DOCK.md

### The dock › Elements: the dock chrome

| Id | Element | Component | Note |
|---|---|---|---|
| DK-01 | Rail | DS-SIDE-1 Dock edge rail | edge rail |
| DK-02 | Rail tab ×8 | DS-SIDE-2 Dock tab | rail tab |
| DK-03 | Tab callout | DS-SIDE-3 Dock tab callout | tab callout |
| DK-04 | AI divider | DS-SIDE-1 Dock edge rail | rail hairline divider under AI tab |
| DK-05 | Count chip on a tab | DS-SIDE-4 Dock count chip | count chip on tab |
| DK-06 | Close all | DS-SIDE-5 Close all | close all |
| DK-07 | Sheet tab strip | DS-SIDE-6 Sheet tab strip | sheet tab strip |
| DK-08 | Panel head identity | DS-SIDE-8 Panel head | head identity: icon and label |
| DK-09 | Head link-out | DS-SIDE-8 Panel head | head link-out view control |
| DK-10 | Head divider | DS-SIDE-8 Panel head | head divider |
| DK-11 | History back | DS-SIDE-9 Panel head button (close, back, forward) | back |
| DK-12 | History forward | DS-SIDE-9 Panel head button (close, back, forward) | forward |
| DK-13 | Panel close | DS-SIDE-9 Panel head button (close, back, forward) | close |
| DK-14 | Grip | DS-SIDE-10 Panel width grip | panel width grip |
| DK-15 | Escape | `content` | keyboard behaviour, nothing drawn |
### Clients panel

| Id | Element | Component | Note |
|---|---|---|---|
| CL-01 | Head: CRM board door | DS-SIDE-8 Panel head | head link-out (clients door) |
| CL-02 | Head: sync stamp | DS-SIDE-8 Panel head | head sync stamp view control |
| CL-03 | Head: sync | DS-SIDE-8 Panel head | head sync view control |
| CL-04 | Head: second divider, back, forward, X | DS-SIDE-9 Panel head button (close, back, forward) | divider, back, forward, close group |
| CL-05 | Search | DS-COMP-22 Dock panel body parts | panel search |
| CL-06 | Count line | DS-COMP-22 Dock panel body parts | count line |
| CL-07 | Client row | DS-COMP-13 List row | panel row, client |
| CL-08 | Triplet: Portal | DS-PRIM-2 Icon button (including close ×) | row hover tool icon button |
| CL-09 | Triplet: Projects | DS-PRIM-2 Icon button (including close ×) | row hover tool icon button |
| CL-10 | Triplet: Docs | DS-PRIM-2 Icon button (including close ×) | row hover tool icon button |
| CL-11 | Comment badge | DS-PRIM-2 Icon button (including close ×) | comment icon button with corner count |
| CL-12 | Empty search result | DS-PRIM-28 Empty state | empty result; none drawn today (defect) |
| CL-13 | Record back | DS-COMP-22 Dock panel body parts | walk-back row |
| CL-14 | Record title | DS-COMP-22 Dock panel body parts | walk-back row title |
### CRM client record and person card › Elements: record half

| Id | Element | Component | Note |
|---|---|---|---|
| CR-01 | Identity tile | DS-PRIM-16 Avatar and avatar stack | client square avatar, large |
| CR-02 | Client name | DS-COMP-22 Dock panel body parts | record identity head: name |
| CR-03 | Industry · package | DS-COMP-22 Dock panel body parts | record identity head: sub line |
| CR-04 | Edit toggle | DS-PRIM-2 Icon button (including close ×) | edit toggle icon button, pressed state |
| CR-05 | Site chip | DS-PRIM-11 Chip and pill | chip with glyph and outside link |
| CR-06 | Last-contact chip | DS-PRIM-11 Chip and pill | chip with glyph |
| CR-07 | Route: Portal | DS-COMP-8 Door card | route door card |
| CR-08 | Route: Projects | DS-COMP-8 Door card | route door card with count |
| CR-09 | Route: Docs | DS-COMP-8 Door card | route door card |
| CR-10 | Next-up strip | DS-COMP-22 Dock panel body parts | next-up strip |
| CR-11 | Next-up door | DS-PRIM-1 Button | secondary sm door button |
| CR-12 | Fact: Type | DS-COMP-13 List row | record row (label, value); edit uses PRIM-5 |
| CR-13 | Fact: Package | DS-COMP-13 List row | record row (label, value) |
| CR-14 | Fact: Services | DS-COMP-13 List row | record row (label, value) |
| CR-15 | Fact: Client since | DS-COMP-13 List row | record row (label, value) |
### CRM client record and person card › Elements: comms half and the person card

| Id | Element | Component | Note |
|---|---|---|---|
| CR-20 | Kind filter ×4 | DS-PRIM-10 Segmented control and facet | facets; PRIM-10 drift names CR-20 |
| CR-21 | Person chip | DS-PRIM-10 Segmented control and facet | facet (.facet) person chip |
| CR-22 | Show more / Show fewer | DS-PRIM-1 Button | ghost text button |
| CR-23 | Person card | DS-COMP-7 Card (content and list card) | content card for one person |
| CR-24 | Card actions | DS-PRIM-1 Button | ghost text buttons, danger hover on Remove |
| CR-25 | Person stamp | DS-COMP-22 Dock panel body parts | action stamp |
| CR-26 | Log control | DS-PRIM-1 Button | mono text button; single control |
| CR-27 | Log input | DS-PRIM-3 Text input | text input |
| CR-28 | Ledger row | DS-COMP-14 Feed and ledger | record ledger row |
| CR-29 | Ledger door | DS-PRIM-26 Link and door link | door link to outside site |
| CR-30 | Empty ledger | DS-PRIM-28 Empty state | empty ledger |
| CR-31 | No record | DS-PRIM-28 Empty state | no record empty state |
### Docs panel

| Id | Element | Component | Note |
|---|---|---|---|
| DC-01 | New note field | DS-PRIM-4 Textarea | textarea |
| DC-02 | Written-on line | DS-PRIM-25 Marker, tag, stamp, index and freshness | mono stamp line |
| DC-03 | Add note | DS-PRIM-1 Button | secondary sm |
| DC-04 | Note | DS-COMP-13 List row | notice row (pinned note) |
| DC-05 | Note origin link | DS-PRIM-26 Link and door link | origin link |
| DC-06 | Note time | DS-PRIM-25 Marker, tag, stamp, index and freshness | stamp |
| DC-07 | File | DS-PRIM-1 Button | mono text button |
| DC-08 | Delete note | DS-PRIM-2 Icon button (including close ×) | delete icon button |
| DC-09 | Filing: Folder | DS-PRIM-5 Select | house select with overline label |
| DC-10 | Filing: Client | DS-PRIM-5 Select | house select |
| DC-11 | File it / Cancel | DS-PRIM-1 Button | primary and secondary sm |
| DC-12 | Pad empty state | DS-PRIM-28 Empty state | pad empty |
| DC-13 | Documents head | DS-COMP-22 Dock panel body parts | section label with count |
| DC-14 | Documents search | DS-COMP-22 Dock panel body parts | panel search (docs drift) |
| DC-15 | Reading line | DS-COMP-22 Dock panel body parts | reading line |
| DC-16 | Document row title | DS-COMP-13 List row | panel row title slot, doc row |
| DC-17 | Document home | DS-PRIM-25 Marker, tag, stamp, index and freshness | mono home tag |
| DC-18 | Document description and meta | DS-COMP-13 List row | panel row main slot desc and meta |
| DC-19 | No match | DS-PRIM-28 Empty state | no match |
| DC-20 | Reader back | DS-COMP-22 Dock panel body parts | walk-back row |
| DC-21 | Reader meta and body | DS-PRIM-25 Marker, tag, stamp, index and freshness | meta stamp; body is estate md type |
### Bookmarks panel

| Id | Element | Component | Note |
|---|---|---|---|
| BM-01 | Bookmark this page | DS-PRIM-1 Button | secondary sm full width |
| BM-02 | Row link | DS-COMP-13 List row | panel row, bookmark |
| BM-03 | Edit | DS-PRIM-2 Icon button (including close ×) | edit icon button |
| BM-04 | Remove | DS-PRIM-2 Icon button (including close ×) | remove icon button |
| BM-05 | Editor: label | DS-PRIM-3 Text input | text input |
| BM-06 | Editor: note | DS-PRIM-3 Text input | text input |
| BM-07 | Editor: address | DS-PRIM-25 Marker, tag, stamp, index and freshness | read-only mono address |
| BM-08 | Save / Cancel | DS-PRIM-1 Button | secondary sm and ghost |
| BM-09 | Empty state | DS-PRIM-28 Empty state | empty bookmarks |
### Projects panel

| Id | Element | Component | Note |
|---|---|---|---|
| PJ-01 | Head: board door | DS-SIDE-8 Panel head | head link-out (board door) |
| PJ-02 | Search input | DS-COMP-22 Dock panel body parts | token search variant |
| PJ-03 | Tag | DS-PRIM-11 Chip and pill | filter tag variant with key |
| PJ-04 | Reading line | DS-COMP-22 Dock panel body parts | reading line |
| PJ-05 | Column heads | DS-COMP-13 List row | list column head row (.tl__head) |
| PJ-06 | Done tick | DS-PRIM-7 Checkbox | tick box |
| PJ-07 | Assignee avatar | DS-PRIM-16 Avatar and avatar stack | round avatar, dashed when unassigned |
| PJ-08 | Task name | DS-COMP-13 List row | panel row title slot, task row |
| PJ-09 | Comment count | DS-PRIM-13 Count | comment count |
| PJ-10 | Due | DS-PRIM-15 Status mark (text and chip) | status text in tone |
| PJ-11 | Priority | DS-PRIM-15 Status mark (text and chip) | status text with bar in tone |
| PJ-12 | No match | DS-PRIM-28 Empty state | no match |
### Team panel

| Id | Element | Component | Note |
|---|---|---|---|
| TM-01 | Teammate face | DS-PRIM-16 Avatar and avatar stack | round avatar |
| TM-02 | Teammate name door | DS-PRIM-26 Link and door link | name door link |
| TM-03 | Unread chip | DS-PRIM-13 Count | unread count |
| TM-04 | Message | DS-COMP-15 Message thread and composer | thread message; chose composite over avatar |
| TM-05 | Composer | DS-COMP-15 Message thread and composer | composer |
| TM-06 | Nobody selected | DS-PRIM-28 Empty state | nobody selected |
### Notifications panel

| Id | Element | Component | Note |
|---|---|---|---|
| NT-01 | Bell count | DS-SIDE-4 Dock count chip | count chip on bell tab |
| NT-02 | Summary | DS-COMP-22 Dock panel body parts | count or reading line (summary) |
| NT-03 | Tab ×2 | DS-COMP-23 Panel tab set | static variant with counts |
| NT-04 | Client group head | DS-COMP-22 Dock panel body parts | group head with owed chip |
| NT-05 | Band sub-head | DS-COMP-22 Dock panel body parts | section label |
| NT-06 | Row | DS-COMP-13 List row | notice row |
| NT-07 | Pin chip | DS-PRIM-11 Chip and pill | dashed pin chip |
| NT-08 | Closed disclosure | DS-COMP-14 Feed and ledger | grouped feed closed-items disclosure |
| NT-09 | Empty (all) | DS-PRIM-28 Empty state | empty, all |
| NT-10 | Empty (tab) | DS-PRIM-28 Empty state | empty, per tab |
### Client intelligence panel

| Id | Element | Component | Note |
|---|---|---|---|
| AI-01 | Title | DS-SIDE-8 Panel head | head identity (AI drift head) |
| AI-02 | Model select | DS-PRIM-5 Select | house select in panel head |
| AI-03 | Add page to context | DS-SIDE-8 Panel head | head view control |
| AI-04 | Head divider, back, forward | DS-SIDE-9 Panel head button (close, back, forward) | divider, back, forward |
| AI-05 | Close | DS-SIDE-9 Panel head button (close, back, forward) | close, AI dialect (R-SIDE-8) |
| AI-06 | Conversation tab | DS-COMP-23 Panel tab set | set variant tab, rename |
| AI-07 | Close conversation | DS-COMP-23 Panel tab set | set variant tab close |
| AI-08 | New conversation | DS-COMP-23 Panel tab set | set variant new tab |
| AI-09 | Messages | DS-COMP-15 Message thread and composer | messages: assistant, user, note |
| AI-10 | Suggestion chip ×5 | DS-PRIM-11 Chip and pill | suggestion chip |
| AI-11 | Input | DS-PRIM-3 Text input | composer input |
| AI-12 | Send | DS-PRIM-1 Button | primary sm |

## TASKS.md

The task page's `TM-01` to `TM-04` below are the ids `PLACEHOLDERS.md` re-keys as `TKM-` (so they never collide with the DOCK Team panel's `TM-`).

### S1. Dock task panel: the head and the shared header

| Id | Element | Component | Note |
|---|---|---|---|
| DP-01 | Panel title | DS-SIDE-8 Panel head | TASK-PAGE: DS-SIDE-8 panel head, label slot; icon DS-PRIM-17 |
| DP-02 | New task | DS-PRIM-2 Icon button (including close ×) | TASK-PAGE: DS-PRIM-2 icon button, default 26, in the head's view slots; hover --accent as DS-COMP-21 |
| DP-03 | Go to the linked section | DS-PRIM-2 Icon button (including close ×) | TASK-PAGE: DS-PRIM-2 default 26; shown only with at |
| DP-04 | Open on the board | DS-PRIM-2 Icon button (including close ×) | TASK-PAGE: DS-PRIM-2 default 26 |
| DP-05 | Open on its own page | DS-PRIM-2 Icon button (including close ×) | TASK-PAGE: DS-PRIM-2 default 26 |
| DP-06 | Back / Forward | DS-SIDE-9 Panel head button (close, back, forward) | TASK-PAGE: DS-SIDE-9 panel head button; disabled state (opacity .4) |
| DP-07 | Close | DS-SIDE-9 Panel head button (close, back, forward) | TASK-PAGE: DS-SIDE-9 close |
| DP-08 | Task name | DS-PRIM-3 Text input | TASK-PAGE: DS-PRIM-3 text input --inline (display face), focus border --accent |
| DP-09 | Ask about this task | DS-PRIM-2 Icon button (including close ×) | TASK-PAGE: DS-PRIM-2 --accent hover variant (the ask sparkle, scale 1.12) |
| DP-10 | Pin (star) | DS-PRIM-2 Icon button (including close ×) | TASK-PAGE: DS-PRIM-2 default 26 + pressed (aria-pressed, glyph --accent) |
| DP-11 | Team tab | DS-COMP-23 Panel tab set | TASK-PAGE: DS-COMP-23 panel tab set, static; count DS-PRIM-13 .cbadge--plain |
| DP-12 | Agent tab | DS-COMP-23 Panel tab set | TASK-PAGE: DS-COMP-23 static + DS-PRIM-13; title via DS-PRIM-18 |
| DP-13 | Tab mark | DS-COMP-23 Panel tab set | TASK-PAGE: DS-COMP-23 selected mark, 2px --accent, left/width over --dur-1 (220 ms) |
| DP-14 | Whose move | DS-TASK-1 Task fact strip | TASK-PAGE: DS-TASK-1 cell, derived |
| DP-15 | Rank | DS-TASK-1 Task fact strip | TASK-PAGE: DS-TASK-1 cell, derived; none state reads "not ranked" |
| DP-16 | Ad hoc | DS-TASK-1 Task fact strip | TASK-PAGE: DS-TASK-1 cell, tick: DS-PRIM-7 checkbox, default 18 |
| DP-17 | Client access | DS-TASK-1 Task fact strip | TASK-PAGE: DS-TASK-1 cell, tick: DS-PRIM-7 |
| DP-18 | Assignee | DS-PRIM-5 Select | TASK-PAGE: DS-PRIM-5 field select with DS-PRIM-16 person avatar 22; menu DS-PRIM-19 option menu (DS-C |
| DP-19 | Client | DS-PRIM-5 Select | TASK-PAGE: DS-PRIM-5 field select |
| DP-20 | Due date | DS-PRIM-5 Select | TASK-PAGE: DS-PRIM-5 date button (.dp__btn); no date: DS-PRIM-28 --inline sentence |
| DP-20a | Date picker: month bar | DS-PRIM-2 Icon button (including close ×) | TASK-PAGE: DS-PRIM-2 default in DS-PRIM-19 date picker (.dp__pop) |
| DP-20b | Date picker: grid | DS-COMP-38 Calendar and date grid | date picker grid variant, in DS-PRIM-19's pop (remapped by the Astra cross-check) |
| DP-20c | Date picker: quick picks | DS-PRIM-1 Button | TASK-PAGE: DS-PRIM-1 --secondary --sm |
| DP-20d | Date picker: open and close | DS-PRIM-5 Select | TASK-PAGE: DS-PRIM-5 date button, open state (--accent border) |
| DP-21 | Estimate | DS-PRIM-5 Select | TASK-PAGE: DS-PRIM-5 field select |
| DP-22 | Project | DS-PRIM-5 Select | TASK-PAGE: DS-PRIM-5 field select |
| DP-23 | Category | DS-PRIM-5 Select | TASK-PAGE: DS-PRIM-5 field select |
| DP-24 | Stage | DS-PRIM-5 Select | TASK-PAGE: DS-PRIM-5 field select |
| DP-25 | Status | DS-PRIM-5 Select | TASK-PAGE: DS-PRIM-5 field select |
| DP-26 | Tags input | DS-COMP-22 Dock panel body parts | TASK-PAGE: DS-TASK-2 tag field, query input (DS-PRIM-3 default) |
| DP-27 | Tag suggestion menu | DS-PRIM-19 Menu and popover | TASK-PAGE: DS-PRIM-19 option menu inside DS-TASK-2, first row is-on |
| DP-28 | Tag chip | DS-PRIM-11 Chip and pill | TASK-PAGE: DS-PRIM-11 --soft + remove × (DS-PRIM-2 compact) inside DS-TASK-2 |
| DP-29 | Page link value | DS-PRIM-26 Link and door link | TASK-PAGE: DS-PRIM-26 link (.sb__addr, mono); empty "nothing yet" DS-PRIM-28 --row |
| DP-30 | Link here / Relink | DS-PRIM-1 Button | TASK-PAGE: DS-PRIM-1 --text (icon only, .sb__relink) |
| DP-31 | Scope stamp (Agent only, agent rows only) | DS-TASK-3 Scope stamp | TASK-PAGE: DS-TASK-3 |
| DP-32 | Context snapshot line (Agent only) | DS-PRIM-25 Marker, tag, stamp, index and freshness | TASK-PAGE: DS-PRIM-25 .stamp with a leading DS-PRIM-17 icon |
| DP-33 | Invitation (Agent only) | DS-PRIM-28 Empty state | TASK-PAGE: DS-PRIM-28 --inline |
| DP-34 | Agent brief | DS-PRIM-4 Textarea | TASK-PAGE: DS-PRIM-4 textarea, Mono variant, 10 rows |
| DP-35 | Description (Team only) | DS-PRIM-4 Textarea | TASK-PAGE: DS-PRIM-4 textarea, Sans default, 4 rows |
### S2. Dock task panel: the Team pane

| Id | Element | Component | Note |
|---|---|---|---|
| DT-01 | Subtasks head | DS-COMP-22 Dock panel body parts | TASK-PAGE: DS-COMP-22 section label + count line (.sb__k, .sb__meta) inside a DS-COMP-22 ruled sectio |
| DT-02 | Add subtask | DS-PRIM-3 Text input | TASK-PAGE: DS-PRIM-3 --inline (underline only) + DS-PRIM-17 plus |
| DT-03 | Open subtask row | DS-COMP-13 List row | TASK-PAGE: DS-COMP-13 list row, panel row: DS-PRIM-7 tick + text + DS-PRIM-16 person 22 (or the agent |
| DT-04 | Gate step | DS-COMP-13 List row | TASK-PAGE: DS-COMP-13 panel row, proposed state gate step: leading DS-PRIM-17 eye, no tick, trailing |
| DT-05 | Archived / superseded row | DS-COMP-13 List row | TASK-PAGE: DS-COMP-13 panel row, proposed state archived (text --text-2) |
| DT-06 | Completed rows + fold | DS-PRIM-1 Button | TASK-PAGE: DS-PRIM-1 --text (.tt__more) |
| DT-07 | Empty remainder | DS-PRIM-28 Empty state | TASK-PAGE: DS-PRIM-28 --inline |
| DT-08 | Time head | DS-COMP-22 Dock panel body parts | TASK-PAGE: DS-COMP-22 label + count line |
| DT-09 | Burn bar | DS-PRIM-23 Meter and progress | TASK-PAGE: DS-PRIM-23 time track (.tt__bar, 4px); over estimate is-over --danger |
| DT-10 | Start timer | DS-PRIM-1 Button | TASK-PAGE: DS-PRIM-1 --secondary --sm, stretched; running state shows the elapsed readout |
| DT-11 | Log field + Log | DS-COMP-26 Form layout | TASK-PAGE: DS-COMP-26 panel form field row: DS-PRIM-3 default + DS-PRIM-1 --secondary --sm |
| DT-12 | Time entry | DS-COMP-13 List row | TASK-PAGE: DS-COMP-13 panel row: DS-PRIM-16 + date + note + minutes + × (DS-PRIM-2 compact, --reveal, |
| DT-13 | More entries | DS-PRIM-1 Button | TASK-PAGE: DS-PRIM-1 --text |
| DT-14 | Conversation tabs | DS-COMP-23 Panel tab set | TASK-PAGE: DS-COMP-23 static + DS-PRIM-13 counts |
| DT-15 | Thread box | DS-COMP-15 Message thread and composer | TASK-PAGE: DS-COMP-15 thread in a scroll box (floor three 2-line messages, cap min(60vh, 32rem)); emp |
| DT-16 | Message | DS-COMP-15 Message thread and composer | TASK-PAGE: DS-COMP-15 thread message (DS-PRIM-16 avatar, name, stamp, "team only" marker, pin chip) |
| DT-17 | Edit / Delete message | DS-PRIM-2 Icon button (including close ×) | TASK-PAGE: DS-PRIM-2 compact 22, --reveal; edit uses DS-PRIM-4 |
| DT-18 | Replies | DS-COMP-15 Message thread and composer | TASK-PAGE: DS-COMP-15 thread, nested one level by the avatar gutter |
| DT-19 | Message signal (client rows) | DS-PRIM-15 Status mark (text and chip) | TASK-PAGE: DS-PRIM-15 status mark, text; reaction DS-PRIM-11 chip |
| DT-20 | Activity rows | DS-COMP-14 Feed and ledger | TASK-PAGE: DS-TASK-8 task trail, activity |
| DT-21 | Composer | DS-COMP-15 Message thread and composer | TASK-PAGE: DS-COMP-15 composer: DS-PRIM-3 --sunk + DS-PRIM-1 --primary --sm "Send" |
| DT-22 | History head | DS-COMP-22 Dock panel body parts | TASK-PAGE: DS-COMP-22 label + reading line |
| DT-23 | History trail | DS-COMP-14 Feed and ledger | TASK-PAGE: DS-TASK-8 task trail, history, folded (DS-PRIM-1 --text toggle) |
### S3. Dock task panel: the Agent pane

| Id | Element | Component | Note |
|---|---|---|---|
| DA-01 | Current run head | DS-COMP-22 Dock panel body parts | TASK-PAGE: DS-COMP-22 label + reading line |
| DA-02 | Run summary card `.trs` | DS-TASK-4 Run summary | TASK-PAGE: DS-TASK-4 run summary, compact; tone by state |
| DA-03 | Workflow toggle | DS-TASK-5 Workflow list | TASK-PAGE: DS-TASK-5 toggle (DS-PRIM-25 key tag + DS-PRIM-31 chevron), closed in the panel |
| DA-04 | Workflow rows | DS-TASK-5 Workflow list | TASK-PAGE: DS-TASK-5 rows; state DS-PRIM-15 text; failure DS-PRIM-30 |
| DA-05 | Staged output | DS-TASK-6 Output and evidence box | TASK-PAGE: DS-TASK-6 output box, staged (kinds diff, pr, ad, preview); PAUSED DS-PRIM-15 chip |
| DA-06 | Live / Was live | DS-TASK-6 Output and evidence box | TASK-PAGE: DS-TASK-6 live / was live + DS-PRIM-1 --secondary --sm Roll back, **disabled** |
| DA-07 | Gate box `.gatebox` | DS-TASK-7 Gate box | TASK-PAGE: DS-TASK-7, armed / stale |
| DA-08 | Skills and data source | DS-PRIM-11 Chip and pill | TASK-PAGE: DS-PRIM-11 --outline chips with a doc glyph; DS-PRIM-26 link |
| DA-09 | Token tracked | DS-TASK-9 Token tracked | TASK-PAGE: DS-TASK-9 |
| DA-10 | Rank calculation | DS-TASK-10 Rank calculation | TASK-PAGE: DS-TASK-10, section |
### S4. New task (the draft)

| Id | Element | Component | Note |
|---|---|---|---|
| DN-01 | Name | DS-PRIM-3 Text input | TASK-PAGE: DS-PRIM-3 --inline, focused on open |
| DN-02 | Guess sentence `.tf__why` | DS-COMP-26 Form layout | TASK-PAGE: DS-COMP-26 inline form helper line (.tf__why) |
| DN-03 | Create task | DS-PRIM-1 Button | TASK-PAGE: DS-PRIM-1 --primary --sm in the form's actions row (.sb__nfoot) |
| DN-04 | Cancel | DS-PRIM-1 Button | TASK-PAGE: DS-PRIM-1 --ghost --sm |
| DN-05 | Draft panes | DS-SIDE-7 Dock panel | TASK-PAGE: panel in its draft (empty) state; panes as S2 and S3 |
### S5. Task page: header, shared facts, Team perspective

| Id | Element | Component | Note |
|---|---|---|---|
| TP-01 | Crumb "Projects →" | DS-PRIM-26 Link and door link | TASK-PAGE: DS-PRIM-26 door link (.sb__addr + door mark) in DS-TASK-11 |
| TP-02 | Crumb trail | DS-TASK-11 Task record header and facts band | TASK-PAGE: DS-TASK-11 crumb text, --text-muted |
| TP-03 | Task id | DS-PRIM-25 Marker, tag, stamp, index and freshness | TASK-PAGE: DS-PRIM-25 key tag |
| TP-04 | State word | DS-PRIM-15 Status mark (text and chip) | TASK-PAGE: DS-PRIM-15 status mark, text (.spill[data-tone]) |
| TP-05 | Copy address | DS-PRIM-2 Icon button (including close ×) | TASK-PAGE: DS-PRIM-2 default; copied state swaps to a check for 1.2 s |
| TP-06 | Title | DS-TASK-11 Task record header and facts band | TASK-PAGE: DS-TASK-11 title |
| TP-07 | Run line | DS-TASK-11 Task record header and facts band | TASK-PAGE: DS-TASK-11 run line (.card__sub) |
| TP-08 | Strip (lifted) | DS-TASK-1 Task fact strip | TASK-PAGE: DS-TASK-1, read-only (ticks are span.sbbox) |
| TP-09 | Calc line `.mcalc` | DS-TASK-10 Rank calculation | TASK-PAGE: DS-TASK-10, line |
| TP-10 | Read-only field grid | DS-COMP-26 Form layout | TASK-PAGE: DS-COMP-26 inline form, read-only (5 / 2 / 1 columns), values .sb__state; Handling as DS-P |
| TP-11 | Tag chips | DS-PRIM-11 Chip and pill | TASK-PAGE: DS-PRIM-11 --soft, no remove |
| TP-12 | Team / Agent switch | DS-COMP-23 Panel tab set | TASK-PAGE: DS-COMP-23 static + DS-PRIM-13 count |
| TT-01 | Description | DS-COMP-22 Dock panel body parts | TASK-PAGE: DS-COMP-22 ruled section; prose; empty DS-PRIM-28 --inline |
| TT-02 | Subtasks | DS-COMP-13 List row | TASK-PAGE: DS-COMP-13 panel row, inert ticks (DS-PRIM-7 static); all blocks open |
| TT-03 | Time | DS-PRIM-23 Meter and progress | TASK-PAGE: DS-PRIM-23 time track + DS-COMP-13 rows, no × |
| TT-04 | Conversation | DS-COMP-23 Panel tab set | TASK-PAGE: DS-COMP-23 static + DS-COMP-15 thread, no composer |
| TT-05 | History | DS-COMP-14 Feed and ledger | TASK-PAGE: DS-TASK-8 history, open |
| TT-06 | Panel doors | DS-PRIM-1 Button | TASK-PAGE: DS-PRIM-1 --text, centred, full width |
### S6. Task page: the Agent perspective

| Id | Element | Component | Note |
|---|---|---|---|
| TA-01 | Run hero `.tph` | DS-TASK-4 Run summary | TASK-PAGE: DS-TASK-4 run summary, hero (2×2 stats) |
| TA-02 | Execution map section | DS-COMP-22 Dock panel body parts | TASK-PAGE: DS-COMP-22 label + reading line around DS-TASK-12 |
| TA-03 | Human gate section | DS-TASK-7 Gate box | TASK-PAGE: DS-TASK-7 + DS-PRIM-1 --text door |
| TA-04 | What it knows so far | DS-TASK-6 Output and evidence box | TASK-PAGE: DS-TASK-6 knows |
| TA-05 | Artefacts and evidence | DS-TASK-6 Output and evidence box | TASK-PAGE: DS-TASK-6 artefact |
| TA-06 | Operational activity | DS-COMP-14 Feed and ledger | TASK-PAGE: DS-TASK-8 ops |
| TA-07 | No-run body | DS-PRIM-28 Empty state | TASK-PAGE: DS-PRIM-28 --inline (four sentences) |
| TA-08 | Granted scope | DS-TASK-3 Scope stamp | TASK-PAGE: DS-TASK-3 + DS-TASK-6 scope |
| TA-09 | What the run was given | DS-COMP-13 List row | TASK-PAGE: DS-COMP-13 record row (.xb__row) + DS-PRIM-26 links |
| TA-10 | Agent brief | DS-COMP-22 Dock panel body parts | TASK-PAGE: prose block in a DS-COMP-22 ruled section |
| TA-11 | What was asked for | DS-TASK-6 Output and evidence box | TASK-PAGE: DS-TASK-6 asked-for |
| TA-12 | Skills / tokens (lifted) | DS-TASK-9 Token tracked | TASK-PAGE: as DA-08, DS-TASK-9 |
### S7. The execution graph

> **Likely replaced.** Every row below belongs to the execution graph (DS-TASK-12 to DS-TASK-14 and its route facets), which is tied to the harness decision and is likely replaced (R63, the owner 26 September). The rows stay mapped as evidence of what the graph must show; the look is not refined.

| Id | Element | Component | Note |
|---|---|---|---|
| TG-01 | Study bar label | DS-PRIM-25 Marker, tag, stamp, index and freshness | TASK-PAGE: DS-PRIM-25 key tag in DS-TASK-12 bar |
| TG-02 | Route facets | DS-PRIM-10 Segmented control and facet | TASK-PAGE: DS-PRIM-10 .facet, pressed = --accent border |
| TG-03 | Legend | DS-TASK-12 Execution graph | TASK-PAGE: DS-TASK-12 legend |
| TG-04 | Stage labels | DS-PRIM-25 Marker, tag, stamp, index and freshness | TASK-PAGE: DS-PRIM-25 key tag + DS-PRIM-27 rule |
| TG-05 | Node card | DS-TASK-13 Graph node card | TASK-PAGE: DS-TASK-13, default / hover / focus-visible / pressed; tone by state |
| TG-06 | Connectors | DS-TASK-12 Execution graph | TASK-PAGE: DS-TASK-12 connector layer (Rail) |
| TG-07 | Inspector | DS-TASK-14 Graph inspector | TASK-PAGE: DS-TASK-14; gate card DS-TASK-7 .gate |
| TG-08 | Orphan note | DS-PRIM-28 Empty state | TASK-PAGE: DS-PRIM-28 --inline |
| TG-09 | Empty states | DS-PRIM-28 Empty state | TASK-PAGE: DS-PRIM-28 --inline |
### S8. Task page: missing and bare

| Id | Element | Component | Note |
|---|---|---|---|
| TKM-01 | Topbar title | DS-COMP-3 Page header | TASK-PAGE: DS-COMP-3 plain |
| TKM-02 | Unknown id sentence | DS-PRIM-30 Error state | TASK-PAGE: **DS-PRIM-30 error state** (the mockup draws DS-PRIM-28 --block); the id in DS-PRIM-25 key |
| TKM-03 | No id sentence | DS-PRIM-28 Empty state | TASK-PAGE: DS-PRIM-28 --block |
| TKM-04 | Door | DS-PRIM-26 Link and door link | TASK-PAGE: DS-PRIM-26 door link |

## BOARDS.md

### The shared board machine (`board.js`) › Board machine elements

| Id | Element | Component | Note |
|---|---|---|---|
| B-01 | Search and filter field `#cbdq` (`searchFieldHtml`, `board.js:159`) | DS-PRIM-6 Search box and keycap | search field with typeahead |
| B-02 | Query parser (`parseQuery`, `board.js:98`) | `content` | parser logic only, nothing drawn |
| B-03 | Typeahead (`typeaheadGroups`/`wireTypeahead`, `board.js:192-310`) | DS-PRIM-19 Menu and popover | typeahead menu, grouped options |
| B-04 | Funnel `[data-funnel]` (command bar only, `board.js:838`) | DS-PRIM-2 Icon button (including close ×) | funnel icon button with corner count |
| B-05 | Filter menu `#cbdmenu` (`menuHtml`, `board.js:810`) | DS-PRIM-19 Menu and popover | funnel popover menu |
| B-06 | Facet button `.cbd__facet` | DS-PRIM-10 Segmented control and facet | facet; PRIM-10 drift names .cbd__facet |
| B-07 | Preset button `.cbd__preset` (`presetBtnHtml`, `board.js:361`) | DS-PRIM-10 Segmented control and facet | preset toggle; PRIM-10 names .cbd__preset ink-fill dialect |
| B-08 | Clear all `.cbd__clear` (`clearAllHtml`, `board.js:312`) | DS-PRIM-1 Button | primary sm, disabled at rest |
| B-09 | Mode button `.cbd__mode` (`board.js:932`) | DS-PRIM-10 Segmented control and facet | mode toggle, preset dialect with accent ring |
| B-10 | Tag chip `.cbd__tag` (`tagChipsHtml`, `board.js:135`) | DS-PRIM-11 Chip and pill | filter tag variant with remove |
| B-11 | Scope chip `.cbd__tag--scope` (`board.js:1010`) | DS-PRIM-11 Chip and pill | filter tag without remove (scope) |
| B-12 | Undo / Redo `.cbd__ico` (`board.js:702`) | DS-PRIM-2 Icon button (including close ×) | undo and redo icon buttons |
| B-13 | Reset columns `[data-reset]` | DS-PRIM-2 Icon button (including close ×) | reset columns icon button |
| B-14 | Divider `.cbd__div` | DS-PRIM-27 Divider and rule | vertical bar divider |
| B-15 | Column head `th > .cbd__th` (`headCells`, `board.js:1113`) | DS-COMP-17 Board table | column head part (label, arrow, grip) |
| B-16 | Sort arrow `.cbd__arrow` | DS-COMP-17 Board table | sort arrow on column head |
| B-17 | Resize grip `.cbd__grip` | DS-COMP-17 Board table | column resize grip |
| B-18 | Width model (`visibleCols` + `resolveShares`, `board.js:412-433`) | DS-COMP-17 Board table | column width model behaviour |
| B-19 | Body cell `td` | DS-PRIM-20 Table and cells | table body cell; tight variant |
| B-20 | Row `tr` | DS-COMP-17 Board table | board row, projects variant |
| B-21 | Group banner `tr.cbd__grp` (`board.js:1196`) | DS-COMP-17 Board table | group row |
| B-22 | Reading line `.cbd__read` (`readLine`, `board.js:577`) | DS-COMP-16 Filter and command bar | read line |
| B-23 | Empty body `.cbd__empty` | DS-PRIM-28 Empty state | filtered board empty |
| B-24 | Board card `.cbd` | DS-COMP-17 Board table | .cbd outer frame of the board |
| B-25 | Category bar fit ladder (`fitCatBar`, `board.js:1276`) | DS-COMP-16 Filter and command bar | category bar fit ladder behaviour |
| B-26 | Sticky stack (command bar only, §87 addendum) | DS-COMP-16 Filter and command bar | sticky command bar and heads behaviour |
### `/projects/`: the Projects board

| Id | Element | Component | Note |
|---|---|---|---|
| P-01 | Page title `Projects` | DS-COMP-3 Page header | page title |
| P-02 | Search field (B-01) | DS-PRIM-6 Search box and keycap | board search field (B-01) |
| P-03 | Funnel (B-04) | DS-PRIM-2 Icon button (including close ×) | funnel (B-04) |
| P-04 | Undo, Redo (B-12) | DS-PRIM-2 Icon button (including close ×) | undo and redo (B-12) |
| P-05 | `SWOT catalogue` | DS-PRIM-1 Button | secondary sm, link |
| P-06 | `New task` | DS-PRIM-1 Button | secondary sm |
| P-07 | Freshness marker `UPDATED 2 HOURS AGO` | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker (an indicator only, never pressed; live sync) |
| P-08 | `Sync` | DS-PRIM-1 Button | secondary sm |
| P-10 | `Review` mode (B-09) | DS-PRIM-10 Segmented control and facet | mode toggle with count (B-09) |
| P-11 | Viewer preset `<owner>` (B-07, pinned) | DS-PRIM-10 Segmented control and facet | preset with avatar, pressed (B-07) |
| P-12 | Divider `.cbd__modediv` | DS-PRIM-27 Divider and rule | mode divider |
| P-13 | Category presets, one per category present (Admin, Branding, Content,… | DS-PRIM-10 Segmented control and facet | category presets with icons (B-07) |
| P-14 | Hidden-filter tags (B-10) | DS-PRIM-11 Chip and pill | filter tags (B-10) |
| P-20 | Rank | DS-COMP-17 Board table | column head: Rank, icon only |
| P-21 | Task name | DS-COMP-17 Board table | column head: Task name |
| P-22 | Client comments | DS-COMP-17 Board table | column head: Client comments, icon only |
| P-23 | Client | DS-COMP-17 Board table | column head: Client |
| P-24 | Assignee | DS-COMP-17 Board table | column head: Assignee |
| P-25 | Due date | DS-COMP-17 Board table | column head: Due date |
| P-26 | Stage | DS-COMP-17 Board table | column head: Stage |
| P-27 | Estimates | DS-COMP-17 Board table | column head: Estimates, icon only at min |
| P-28 | Actual | DS-COMP-17 Board table | column head: Actual; burn bar is COMP-29 |
| P-30 | Tick box `.sbbox` | DS-PRIM-7 Checkbox | tick box |
| P-31 | Clearance chip | DS-PRIM-11 Chip and pill | clearance pill, accent tone for Spend and Break-glass |
| P-32 | Task name `.cbd__nm` | DS-COMP-17 Board table | name cell, projects variant |
| P-33 | Hover tools `.cbd__routes--pop` | DS-COMP-17 Board table | hover tools popover (board anatomy) |
| P-34 | Starred rows | `content` | no visual; sort rule only |
| P-35 | Name cell on a to-do row | DS-COMP-17 Board table | name cell on to-do row |
| P-36 | Comment badge `.cbd__cmt` | DS-PRIM-2 Icon button (including close ×) | comment icon button with corner count |
| P-37 | Inline cell editors (assignee, due, stage, estimate) `.cbd__cell[data… | DS-PRIM-5 Select | house select or date pop in a cell |
### `/projects/`: the Projects board › The Review queue (P-40, board in Review mode)

| Id | Element | Component | Note |
|---|---|---|---|
| P-40 | Summary line `.rq__say` | `content` | summary sentence copy; no candidate |
| P-41 | Card `.rq__item`, sorted by due date | DS-COMP-11 Recommendation card | queue item variant |
| P-42 | Head: agent avatar | DS-PRIM-16 Avatar and avatar stack | dashed agent avatar |
| P-43 | Head: client chip-door | DS-PRIM-11 Chip and pill | outline pill that links (door) |
| P-44 | Head: category pill | DS-PRIM-11 Chip and pill | outline pill |
| P-45 | Head: clearance chip | DS-PRIM-11 Chip and pill | clearance pill (as P-31) |
| P-46 | Head: `Discussing` flag | DS-PRIM-15 Status mark (text and chip) | warn status marker; chose status over mono tag |
| P-47 | Head: figures `.rq__figs` | DS-PRIM-25 Marker, tag, stamp, index and freshness | mono figures line; only COMP-11 offered |
| P-48 | Recommendation card (`recCard(r, {state:false, foot})`, `ui.js:795`) | DS-COMP-11 Recommendation card | recommendation card |
| P-49 | Foot: `View plan` | DS-PRIM-1 Button | secondary sm with icon |
| P-50 | Foot: skills | DS-PRIM-11 Chip and pill | skill chips with SKILLS label |
| P-51 | Empty queue | DS-PRIM-28 Empty state | empty review queue |
### `/projects/`: the Projects board › The SWOT catalogue (`/projects/?swot=s\|w\|o\|t`)

| Id | Element | Component | Note |
|---|---|---|---|
| P-60 | `Back to tasks` | DS-PRIM-1 Button | secondary sm link |
| P-61 | Heading block | DS-COMP-4 Section head | section head with tag and count marker |
| P-62 | Book switch `nav.cbd__filters` | DS-PRIM-10 Segmented control and facet | link presets as a book switch |
| P-63 | Read line | DS-COMP-16 Filter and command bar | read line; empty wording is copy |
| P-64 | Table (auto layout, no icons, no sort, no resize) | DS-COMP-17 Board table | swot variant |
| P-65 | `Move to` select | DS-PRIM-5 Select | house select; banner after is PRIM-22 |
| P-66 | Narrow layout (≤ 700px, by `matchMedia` at render time) | DS-COMP-13 List row | narrow swot rows as page rows |
| P-67 | Empty book | DS-PRIM-28 Empty state | empty book |
### `/projects/#review`: the agency Review twin

| Id | Element | Component | Note |
|---|---|---|---|
| R-01 | Filter row: `FILTER` label, `Clear all` (B-08), presets `<owner>` (wit… | DS-COMP-16 Filter and command bar | filter bar variant |
| R-02 | Review card `.card.rcard#item-<id>` | DS-COMP-18 Board card | review variant |
| R-03 | Kind glyph `.rglyph` | DS-PRIM-25 Marker, tag, stamp, index and freshness | mono kind tag |
| R-04 | Title `.card__title` + sub `{project} · comments sync to the project… | DS-COMP-18 Board card | card head title and sub line |
| R-05 | Status chip | DS-PRIM-15 Status mark (text and chip) | status chip |
| R-06 | Viewer | DS-COMP-18 Board card | viewer part of the review card |
| R-07 | `Approve` (primary) / `Approved` (secondary, disabled) | DS-PRIM-1 Button | primary sm, secondary disabled when approved |
| R-08 | `Request changes` | DS-PRIM-1 Button | secondary sm |
| R-09 | `View task` | DS-PRIM-1 Button | secondary sm |
| R-10 | Thread `.thread`: `Show 5 more · n earlier` link, then the last 3 mes… | DS-COMP-15 Message thread and composer | thread with show-more link |
| R-11 | Edit own comment (pencil) | DS-PRIM-2 Icon button (including close ×) | edit pencil icon button |
| R-12 | Composer `Leave feedback…` + `Send` | DS-COMP-15 Message thread and composer | composer: input plus primary |
### `/projects/#worklog`: the agency activity ledger

| Id | Element | Component | Note |
|---|---|---|---|
| L-01 | Search `#actQ` (placeholder `Search everything — a name, “comment”, “… | DS-PRIM-6 Search box and keycap | ledger search |
| L-02 | `Clear` | DS-PRIM-1 Button | clear button |
| L-03 | Reading line | DS-COMP-16 Filter and command bar | read line |
| L-04 | Count line | DS-COMP-16 Filter and command bar | read line, n of m count |
| L-05 | Day heading `.act__day` | DS-COMP-14 Feed and ledger | activity ledger sticky day head |
| L-06 | Row `.act__row[data-proj]` | DS-COMP-14 Feed and ledger | activity ledger row |
| L-07 | Project link `.act__proj` | DS-PRIM-26 Link and door link | project link |
| L-08 | Empty state | DS-PRIM-28 Empty state | ledger empty result |
### `/clients/`: the CRM board › Elements: the Clients tab

| Id | Element | Component | Note |
|---|---|---|---|
| C-01 | Search (B-01) | DS-PRIM-6 Search box and keycap | board search field (B-01) |
| C-02 | `Clear all` (B-08) | DS-PRIM-1 Button | clear all (B-08); only COMP-16 offered |
| C-03 | Preset `Needs attention` (B-07) | DS-PRIM-10 Segmented control and facet | preset with icon and count (B-07) |
| C-04 | Preset `Needs response` | DS-PRIM-10 Segmented control and facet | preset with icon and count (B-07) |
| C-05 | Top-5 facets + `Show all filters (n more)` (B-06) | DS-PRIM-10 Segmented control and facet | facets (B-06) |
| C-06 | Undo, Redo, divider (B-12, B-14) | DS-COMP-16 Filter and command bar | actions group: undo, redo, divider |
| C-07 | `New client` | DS-PRIM-1 Button | secondary sm, unwired dress |
| C-08 | Freshness marker, `Sync` | DS-COMP-3 Page header | page header meta slot: freshness and Sync |
| C-10 | Client | DS-COMP-17 Board table | column head: Client |
| C-11 | Client comments | DS-COMP-17 Board table | column head: Client comments, icon only |
| C-12 | Contact | DS-COMP-17 Board table | column head: Contact |
| C-13 | Tags | DS-COMP-17 Board table | column head: Tags |
| C-14 | Services | DS-COMP-17 Board table | column head: Services |
| C-15 | Contacted | DS-COMP-17 Board table | column head: Contacted |
| C-16 | Spend | DS-COMP-17 Board table | column head: Spend |
| C-17 | Work available | DS-COMP-17 Board table | column head: Work available, icon only |
| C-20 | Initials square `.cbd__av` | DS-PRIM-16 Avatar and avatar stack | client square avatar |
| C-21 | Name `.cbd__nm` | DS-COMP-17 Board table | name cell, crm variant |
| C-22 | Name door mark `.cbd__namemark` | DS-PRIM-17 Icon and door mark | door mark glyph; PRIM-17 owns door marks |
| C-23 | Route trio `.cbd__routes` (in flow, **reserves its width** even when… | DS-COMP-17 Board table | route trio in flow (hover tools) |
| C-24 | Capacity squares `.stg__rb--sm` × 3 (Agent `fi-rr-sparkles`, Review `… | DS-COMP-19 Stage strip | capacity squares, small 22px reuse |
| C-25 | Row | DS-COMP-17 Board table | board row, crm variant |
### `/clients/`: the CRM board › The Leads tab (`/clients/#leads`)

| Id | Element | Component | Note |
|---|---|---|---|
| C-30 | Same filter row | DS-COMP-16 Filter and command bar | filter bar variant |
| C-31 | Table, **not resizable** (`table-layout: auto`, no grips) | DS-COMP-17 Board table | leads variant |
| C-32 | Rows | DS-COMP-17 Board table | leads rows, no action |
| C-33 | `New client` | DS-PRIM-1 Button | secondary sm, unwired |
### `/clients/`: the CRM board › The people-review tab (`/clients/#review`)

| Id | Element | Component | Note |
|---|---|---|---|
| C-40 | Filter row | DS-COMP-16 Filter and command bar | filter bar variant |
| C-41 | Client group `.cbd__qg` | DS-COMP-7 Card (content and list card) | list card per client |
| C-42 | Group head `.cbd__qh` | DS-COMP-7 Card (content and list card) | card head as full-width button |
| C-43 | Person row `.cbd__qr` | DS-COMP-13 List row | page row; not a board row |
| C-44 | `Add as contact`, `Dismiss` | DS-PRIM-1 Button | secondary sm, unwired |
| C-45 | Count | `content` | counting rule for the read line |
### `/clients/:client/projects/`: the client-scoped board and the stage strip › The stage strip (`mountDec

| Id | Element | Component | Note |
|---|---|---|---|
| S-01 | Band `.jband` | DS-COMP-19 Stage strip | strip band |
| S-02 | Group labels `.jband__k` | DS-COMP-19 Stage strip | group labels over stages |
| S-03 | Stage card `.stg` | DS-COMP-19 Stage strip | stage card, priority and picked states |
| S-04 | Stage pick `.stg__pick` (the card's text block) | DS-COMP-19 Stage strip | stage card text block |
| S-05 | Family squares `.stg__rb` × 3 (Agent `fi-rr-sparkles`, Review `fi-rr-… | DS-COMP-19 Stage strip | capacity squares, 29px |
### `/clients/:client/projects/`: the client-scoped board and the stage strip › Board differences from `/p

| Id | Element | Component | Note |
|---|---|---|---|
| M-01 | Scope chip `Client <client name>` (B-11; the mockup's sample reads "Meridian Dental") | DS-PRIM-11 Chip and pill | scope filter tag (B-11) |
| M-02 | Viewer preset `<owner>` | DS-PRIM-10 Segmented control and facet | viewer preset, off (B-07) |
| M-03 | Client column and Client facets | `content` | a removal, nothing drawn |
| M-04 | Category chips | DS-PRIM-10 Segmented control and facet | category presets (B-07) |
| M-05 | Groups | DS-COMP-17 Board table | group rows, completed state |
| M-06 | `Ask us` in the title row | DS-PRIM-1 Button | Ask us button in the title row |
| M-07 | Freshness | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker, typed |
| M-08 | Row click | DS-COMP-17 Board table | row click behaviour |
### `/clients/:client/projects/roadmap/`: growth roadmap

| Id | Element | Component | Note |
|---|---|---|---|
| G-01 | Page banner `<Client>'s projects…` (the mockup's sample reads "Meridian's") (shared with the other tabs) | DS-PRIM-22 Banner and tip | info banner with dismiss |
| G-02 | Roadmap banner `Growth roadmap — indicative. The real one is generate… | DS-PRIM-22 Banner and tip | info banner with dismiss |
| G-03 | Three columns `.road` | DS-COMP-20 Roadmap columns | three columns |
| G-04 | Column head `.road__head` | DS-COMP-20 Roadmap columns | column head |
| G-05 | Item `.road__item` | DS-COMP-20 Roadmap columns | roadmap item, accent left rule |
| G-06 | Command bar in the title row | DS-COMP-16 Filter and command bar | command bar placement; no candidate |
### `/clients/:client/projects/reviews/`

| Id | Element | Component | Note |
|---|---|---|---|
| V-01 | Project card (left half) | DS-COMP-18 Board card | project variant |
| V-02 | Review card (left half) | DS-COMP-18 Board card | review variant |
| V-03 | `Approve` / `Approved` (disabled), `Request changes` | DS-PRIM-1 Button | primary and secondary sm |
| V-04 | Thread (right half) `.thread__msgs` | DS-COMP-15 Message thread and composer | thread scroller with empty line |
| V-05 | Edit pencil on messages | DS-PRIM-2 Icon button (including close ×) | edit pencil icon button |
| V-06 | Composer | DS-COMP-15 Message thread and composer | composer: input plus primary |

## AGENCY.md

### Shared components on these pages (AG-K)

| Id | Element | Component | Note |
|---|---|---|---|
| AG-K1 | Sync marker `button.marker.fresh` in the header meta slot | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker variant (an indicator only, never pressed; live sync); header slot is DS-COMP-3 |
| AG-K2 | Page tip `.banner.banner--info.sectip` | DS-PRIM-22 Banner and tip | tip variant (info + sectip); placement per DS-COMP-5 |
| AG-K3 | Section head `sectionHead(num, title, right, tip)` | DS-COMP-4 Section head | numbered, unnumbered (! ?) and optional section tip |
| AG-K4 | Verdict strip `verdictStrip(v)` | DS-COMP-9 Verdict strip | default verdict strip |
| AG-K5 | Verdict row `.vrow` | DS-COMP-9 Verdict strip | verdict row part; band track is DS-COMP-29 |
| AG-K6 | Source link `a.chlink` | DS-PRIM-26 Link and door link | source link, mono upper-case |
| AG-K7 | Ask icon `button.askbtn` | DS-PRIM-2 Icon button (including close ×) | ask icon button |
| AG-K8 | Task icon `button.askbtn.askbtn--task` | DS-PRIM-2 Icon button (including close ×) | task icon button |
| AG-K9 | Stat tile `kpiSm` in `.statrow` | DS-PRIM-24 KPI number | single tile; the row is DS-COMP-6 |
| AG-K10 | AI suggestion card `aiCard` | DS-COMP-10 Finding card | AI finding card; badge, buttons are its parts |
| AG-K11 | Meter `meter(pct, {target, status})` | DS-PRIM-23 Meter and progress | default meter with target tick and tones |
| AG-K12 | Sortable table `table(cols, rows)` | DS-PRIM-20 Table and cells | sortable table variant |
| AG-K13 | Hint `hint(text, action)` | DS-PRIM-22 Banner and tip | hint variant (drift: drop into info banner) |
| AG-K14 | Facet button `.facet` in `.facets` | DS-PRIM-10 Segmented control and facet | facet variant with inline count |
| AG-K15 | Layer `layer('L2', title, sub, body, {open})` | DS-COMP-12 Disclosure layer | L2 layer; one component, parts are chevron and tag |
| AG-K16 | Clearance chip `clearanceChip` | DS-PRIM-11 Chip and pill | outline chip, clearance scale tones |
| AG-K17 | House select `.sel` (`aaWireSelects`) | DS-PRIM-5 Select | house select; its open list is DS-PRIM-19 |
| AG-K18 | Legend `.legend` | DS-PRIM-15 Status mark (text and chip) | legend = row of status words in tone |
| AG-K19 | Status line mark `.sline` | DS-PRIM-14 Dot and status line | sline status line |
### Portfolio Command (`/dashboard/portfolio/`)

| Id | Element | Component | Note |
|---|---|---|---|
| AG-P1 | Page title | DS-COMP-3 Page header | page title in header |
| AG-P2 | Sync marker | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker (an indicator only, never pressed; live sync), warn tone when a connector is bad |
| AG-P3 | Comparison basis | DS-PRIM-10 Segmented control and facet | segmented, three options |
| AG-P4 | Period button | DS-PRIM-1 Button | secondary sm period button |
| AG-P5 | Page tip | DS-PRIM-22 Banner and tip | page tip; placement per DS-COMP-5 |
| AG-P6 | 001 head | DS-COMP-4 Section head | numbered 001 with right marker and tip |
| AG-P7 | Verdict strip | DS-COMP-9 Verdict strip | default verdict strip |
| AG-P8 | Stat tiles ×5 | DS-COMP-6 Stat row | stat row of five tiles |
| AG-P9 | Footnote | `content` | footnote copy, muted small text |
| AG-P10 | 002 head | DS-COMP-4 Section head | numbered 002 (no candidate; it is AG-K3) |
| AG-P11 | AI cards ×3 | DS-COMP-10 Finding card | three stacked AI cards |
| AG-P12 | Approvals card | DS-COMP-7 Card (content and list card) | flush list card with head |
| AG-P13 | Approval rows ×4 | DS-COMP-13 List row | page row with approve and skip buttons |
| AG-P14 | Approvals footnote | `content` | card footnote copy |
| AG-P15 | 003 head | DS-COMP-4 Section head | numbered 003 (no candidate; it is AG-K3) |
| AG-P16 | Needs-attention card | DS-COMP-7 Card (content and list card) | flush list card; soft count chip in head |
| AG-P17 | Alert rows ×8 | DS-COMP-8 Door card | row door (a.trow) with severity line |
| AG-P18 | Renewals card | DS-COMP-7 Card (content and list card) | list card of name and date rows |
| AG-P19 | Budget pacing card | DS-COMP-7 Card (content and list card) | list card holding pacing rows |
| AG-P20 | Pacing rows ×5 (largest absolute variance first) | DS-COMP-13 List row | page row with meter and target tick |
| AG-P21 | 004 head | DS-COMP-4 Section head | numbered 004 (no candidate; it is AG-K3) |
| AG-P22 | Status filter | DS-PRIM-10 Segmented control and facet | segmented filter with counts; chose control over bar |
| AG-P23 | Sort note | DS-PRIM-25 Marker, tag, stamp, index and freshness | mono sort note |
| AG-P24 | The book table | DS-PRIM-20 Table and cells | sortable table with tfoot |
| AG-P24a | Client cell | DS-PRIM-20 Table and cells | name cell with status line and sub |
| AG-P24b | Qual. trend | DS-COMP-29 Inline chart (sparkline, bar list, band track) | sparkline 74x22, no end dot |
| AG-P24c | Qual. | DS-PRIM-20 Table and cells | numeric cell with sub-line (no candidate) |
| AG-P24d | CPQL | DS-PRIM-20 Table and cells | numeric cell, status tone; term tooltip head |
| AG-P24e | ROI | DS-PRIM-20 Table and cells | numeric cell, status tone; chose cell over status mark |
| AG-P24f | Spend | DS-PRIM-20 Table and cells | numeric cell (no candidate) |
| AG-P24g | Pacing | DS-PRIM-20 Table and cells | marker cell in status colour; chose cell |
| AG-P24h | Last touch | DS-PRIM-20 Table and cells | numeric cell, status tone; chose cell |
| AG-P24i | Cycle | DS-PRIM-25 Marker, tag, stamp, index and freshness | marker letters with title tooltip |
| AG-P24j | Flags | DS-PRIM-11 Chip and pill | outline count chip, bad or warn tone |
| AG-P24k | Foot row | DS-PRIM-20 Table and cells | tfoot totals row (no candidate) |
| AG-P25 | Show more | DS-PRIM-1 Button | secondary sm show-more with muted note |
| AG-P26 | Legend | DS-PRIM-15 Status mark (text and chip) | legend of status words (AG-K18) |
| AG-P27 | Bulk action bar | DS-COMP-16 Filter and command bar | action bar variant |
### Executive Rollup (`/dashboard/executive/`)

| Id | Element | Component | Note |
|---|---|---|---|
| AG-E1 | Page title | DS-COMP-3 Page header | page title in header |
| AG-E2 | Sync marker | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker (an indicator only, never pressed; live sync) |
| AG-E3 | Range control | DS-PRIM-10 Segmented control and facet | segmented, three options |
| AG-E4 | Page tip | DS-PRIM-22 Banner and tip | page tip; placement per DS-COMP-5 |
| AG-E5 | 001 head | DS-COMP-4 Section head | numbered 001 with range marker (AG-K3) |
| AG-E6 | Verdict strip | DS-COMP-9 Verdict strip | verdict strip (AG-K4/K5); no composite candidate given |
| AG-E7 | Money chart card | DS-COMP-7 Card (content and list card) | chart card with legend |
| AG-E8 | Money line chart | DS-COMP-27 Axis chart (line, column) | line chart |
| AG-E9 | Money tiles ×4 in two `g2` rows | DS-COMP-6 Stat row | stat row, two g2 rows of tiles |
| AG-E10 | "!" head | DS-COMP-4 Section head | unnumbered ! head; candidate empty state was wrong |
| AG-E11 | Attention feed head | DS-COMP-14 Feed and ledger | attention feed head |
| AG-E12 | Attention row ×10 | DS-COMP-14 Feed and ledger | attention feed row (.arow) |
| AG-E13 | "?" head | DS-COMP-4 Section head | unnumbered ? head; candidate empty state was wrong |
| AG-E14 | Queue head and law | DS-COMP-14 Feed and ledger | feed head with law line (no candidate) |
| AG-E15 | Action card ×8 (`article.paction`, `id=PA-###`) | DS-COMP-11 Recommendation card | queue item, shut; recommendation card fits over list row |
| AG-E16 | Action card, open | DS-COMP-11 Recommendation card | open state: reason, priors, decision buttons |
| AG-E17 | Hash opener | `content` | hash-open behaviour, no visual element |
| AG-E18 | "Already run" layer | DS-COMP-12 Disclosure layer | L2 layer, shut, of executed rows |
| AG-E19 | 002 head | DS-COMP-4 Section head | numbered 002 (AG-K3) |
| AG-E20 | AI cards ×2 | DS-COMP-10 Finding card | two AI cards (AG-K10) |
| AG-E21 | 003 head | DS-COMP-4 Section head | numbered 003 (AG-K3) |
| AG-E22 | Service-line table | DS-PRIM-20 Table and cells | table with swatch and meter cells |
| AG-E23 | MRR mix donut | DS-COMP-28 Radial chart (donut, gauge, score dial) | donut |
| AG-E24 | 004 head | DS-COMP-4 Section head | numbered 004 (AG-K3) |
| AG-E25 | Profitability table | DS-PRIM-20 Table and cells | table with status meter cells |
| AG-E26 | Profitability hint | DS-PRIM-22 Banner and tip | hint variant with action button |
| AG-E27 | Team use card | DS-COMP-7 Card (content and list card) | list card of person rows with meters |
| AG-E28 | Book movement card | DS-COMP-7 Card (content and list card) | content card of toned figures and rules |
| AG-E29 | 005 head | DS-COMP-4 Section head | numbered 005 (AG-K3) |
| AG-E30 | Cost tiles ×4 | DS-COMP-6 Stat row | stat row of four tiles; chose row over tile |
| AG-E31 | Cost log table | DS-PRIM-20 Table and cells | log table |
| AG-E32 | By model card | DS-COMP-7 Card (content and list card) | list card with quiet meters |
| AG-E33 | By attachment card | DS-COMP-7 Card (content and list card) | list card with quiet meters |
### Connections & Signal (`/connections/`) › Elements, sections 001 to 005

| Id | Element | Component | Note |
|---|---|---|---|
| AG-C1 | Page title | DS-COMP-3 Page header | page title in header |
| AG-C2 | Sync marker | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker (an indicator only, never pressed; live sync) |
| AG-C3 | Run all syncs | DS-PRIM-1 Button | secondary sm button |
| AG-C4 | Page tip | DS-PRIM-22 Banner and tip | page tip; placement per DS-COMP-5 |
| AG-C5 | 001 head | DS-COMP-4 Section head | numbered 001 (AG-K3) |
| AG-C6 | Broken banner | DS-PRIM-22 Banner and tip | bad banner (page alert placement) |
| AG-C7 | Fix now | DS-PRIM-1 Button | primary sm inside banner |
| AG-C8 | Verdict strip | DS-COMP-9 Verdict strip | verdict strip (no composite candidate given) |
| AG-C9 | Fleet tiles ×5 | DS-COMP-6 Stat row | stat row of five tiles with tracks |
| AG-C10 | Footnote | `content` | footnote copy |
| AG-C11 | 002 head | DS-COMP-4 Section head | numbered 002 (AG-K3) |
| AG-C12 | Status facets | DS-COMP-16 Filter and command bar | page facets variant with status lines |
| AG-C13 | Sort note | DS-PRIM-25 Marker, tag, stamp, index and freshness | mono sort note; chose text voice over bar |
| AG-C14 | Connector table header | DS-PRIM-20 Table and cells | table.conn head (drift dialect); chose table over card |
| AG-C15 | Connector row ×10 (of 14) | DS-PRIM-20 Table and cells | table.conn expandable row; chose table over list row |
| AG-C16 | Detail panel | DS-PRIM-20 Table and cells | table.conn expanded detail row; chips and blocks inside |
| AG-C17 | Credential pill | DS-PRIM-11 Chip and pill | vaultpill (drift: drop to outline chip) |
| AG-C18 | Row actions | DS-PRIM-1 Button | ghost or secondary sm row buttons |
| AG-C19 | Show more | DS-PRIM-1 Button | ghost sm show-more with page info |
| AG-C20 | Legend | DS-PRIM-15 Status mark (text and chip) | legend of status words |
| AG-C21 | 003 head | DS-COMP-4 Section head | numbered 003 (AG-K3) |
| AG-C22 | Token expiry card | DS-COMP-7 Card (content and list card) | list card of expiry rows |
| AG-C23 | Token hint | DS-PRIM-22 Banner and tip | hint variant with action button |
| AG-C24 | Fleet AI card | DS-COMP-10 Finding card | fleet-scoped AI card (AG-K10) |
| AG-C25 | Quota burn card | DS-COMP-7 Card (content and list card) | list card of quota meters |
| AG-C26 | 004 head | DS-COMP-4 Section head | numbered 004 (AG-K3) |
| AG-C27 | Known truth gaps card | DS-COMP-7 Card (content and list card) | list card of annotation rows |
| AG-C28 | Restatement window card | DS-COMP-7 Card (content and list card) | list card of toned window rows |
| AG-C29 | Empty-state audit card | DS-COMP-7 Card (content and list card) | list card of audit rows |
| AG-C30 | 005 head | DS-COMP-4 Section head | numbered 005 (AG-K3) |
| AG-C31 | Band rows | DS-COMP-13 List row | page row with state chip |
### Connections & Signal (`/connections/`) › Elements, sections 006 to 012 (the operations region)

| Id | Element | Component | Note |
|---|---|---|---|
| AG-C32 | 006 head | DS-COMP-4 Section head | numbered 006 (AG-K3) |
| AG-C33 | Grants lede | `content` | lede copy with derived counts |
| AG-C34 | Grant groups | DS-COMP-7 Card (content and list card) | flush list card grouped by state |
| AG-C35 | Grant row | DS-COMP-13 List row | page row: agent, scope, channel, ttl |
| AG-C36 | Grants sentences ×4 | `content` | meta sentences |
| AG-C37 | 007 head | DS-COMP-4 Section head | numbered 007 (AG-K3) |
| AG-C38 | Tripwires lede | `content` | lede copy with derived counts |
| AG-C39 | Tripwire row ×5 | DS-COMP-13 List row | page row with state chip; dead variant |
| AG-C40 | 008 head | DS-COMP-4 Section head | numbered 008 (AG-K3) |
| AG-C41 | Night lede | DS-COMP-14 Feed and ledger | feed head of the night round |
| AG-C42 | Night timeline | DS-COMP-14 Feed and ledger | time-ordered steps with timeline dots; chose feed |
| AG-C43 | Roster | DS-COMP-7 Card (content and list card) | flush list card of loops |
| AG-C44 | 012 head | DS-COMP-4 Section head | numbered 012; candidate empty state was wrong |
| AG-C45 | Skill lede | `content` | lede copy with derived counts |
| AG-C46 | Skill row | DS-COMP-13 List row | page row: name link, scope chip, figures |
| AG-C47 | Attribution foot | `content` | foot copy with derived figures |
| AG-C48 | Client scope bar | DS-COMP-16 Filter and command bar | scope bar with select; filter bar variant |
| AG-C49 | 009 head | DS-COMP-4 Section head | numbered 009 (AG-K3) |
| AG-C50 | Recompute line and ladder | DS-COMP-13 List row | ladder rows of chip plus sentence (no composite candidate) |
| AG-C51 | Graduation row | DS-COMP-13 List row | page row: type, clearance, state, switch |
| AG-C52 | Bar note | `content` | meta note copy |
| AG-C53 | Pre-approval card | DS-COMP-7 Card (content and list card) | list card with removable sentence rows |
| AG-C54 | Add sentence row | DS-COMP-26 Form layout | inline form: input, select, button |
| AG-C55 | 010 head | DS-COMP-4 Section head | numbered 010 (AG-K3) |
| AG-C56 | Executor gate | DS-TASK-7 Gate box | gate card `.gate`; consolidation gives it one home, DS-TASK-7 |
| AG-C57 | Channel row | DS-COMP-13 List row | page row: glyph, name, read and exec tags |
| AG-C58 | Channel sentences | `content` | meta sentences |
| AG-C59 | 011 head | DS-COMP-4 Section head | numbered 011 (AG-K3) |
| AG-C60 | Known quirks card | DS-COMP-7 Card (content and list card) | list card of exception rows |
| AG-C61 | Raised last night card | DS-COMP-7 Card (content and list card) | list card of finding rows with inline form |
| AG-C62 | Exception sentences | `content` | meta sentences |
### Site Health (`/connections/site-health/`)

| Id | Element | Component | Note |
|---|---|---|---|
| AG-S1 | Page title + source marks | DS-COMP-3 Page header | page title with source favicons |
| AG-S2 | Sync marker | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker (an indicator only, never pressed; live sync) |
| AG-S3 | Check all now | DS-PRIM-1 Button | secondary sm button |
| AG-S4 | Down banner | DS-PRIM-22 Banner and tip | bad banner with action (page alert placement) |
| AG-S5 | Page tip | DS-PRIM-22 Banner and tip | page tip; placement per DS-COMP-5 |
| AG-S6 | 001 head | DS-COMP-4 Section head | numbered 001 (AG-K3) |
| AG-S7 | Verdict strip | DS-COMP-9 Verdict strip | verdict strip (no composite candidate given) |
| AG-S8 | Next move | DS-COMP-10 Finding card | next-move pager around one AI card (no composite candidate) |
| AG-S9 | 002 head | DS-COMP-4 Section head | numbered 002 (AG-K3) |
| AG-S10 | Fleet tiles ×5 | DS-COMP-6 Stat row | stat row of five tiles |
| AG-S11 | Site facets | DS-COMP-16 Filter and command bar | page facets variant |
| AG-S12 | Fleet table | DS-PRIM-20 Table and cells | table.conn with sparkline and band cells |
| AG-S13 | Band cell | DS-PRIM-15 Status mark (text and chip) | four toned letter marks with title |
| AG-S14 | 003 head | DS-COMP-4 Section head | numbered 003, right chip |
| AG-S15 | Uptime layer | DS-COMP-12 Disclosure layer | L2 layer, open, two cards inside |
| AG-S16 | 004 head | DS-COMP-4 Section head | numbered 004, right chip |
| AG-S17 | Maintenance layer | DS-COMP-12 Disclosure layer | L2 layer with tiles and table (no composite candidate) |
| AG-S18 | 005 head | DS-COMP-4 Section head | numbered 005, right chip |
| AG-S19 | Security layer | DS-COMP-12 Disclosure layer | L2 layer of four cards (no composite candidate) |
| AG-S20 | Blocked-requests chart | DS-COMP-27 Axis chart (line, column) | column chart |
| AG-S21 | 006 head | DS-COMP-4 Section head | numbered 006, right chip |
| AG-S22 | Hosting layer | DS-COMP-12 Disclosure layer | L2 layer with gauges and deploy rows; chose layer |
| AG-S23 | Speed layer | DS-COMP-12 Disclosure layer | L2 layer (no composite candidate) |
| AG-S24 | Lighthouse card | DS-COMP-7 Card (content and list card) | chart card with segmented and score dials |
| AG-S25 | Field card | DS-COMP-7 Card (content and list card) | list card of metric rows |
| AG-S26 | Lab timings card | DS-COMP-7 Card (content and list card) | list card of metric rows |
| AG-S27 | Findings card | DS-COMP-7 Card (content and list card) | list card of disclosure findings |
| AG-S28 | Trend card | DS-COMP-7 Card (content and list card) | card of daily rows; chose card over feed |
### Activation Map (`/clients/:client/activation-map/`)

| Id | Element | Component | Note |
|---|---|---|---|
| AG-A1 | Page title | DS-COMP-3 Page header | page title in header |
| AG-A2 | Sync marker | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker (an indicator only, never pressed; live sync) |
| AG-A3 | Client chip | DS-PRIM-11 Chip and pill | outline chip |
| AG-A4 | Intro | DS-COMP-34 Journey map | intro part |
| AG-A5 | Missing-contract state | DS-PRIM-28 Empty state | missing-contract empty state of the map |
| AG-A6 | Legend and filter | DS-COMP-16 Filter and command bar | legend filter variant inside the journey map |
| AG-A7 | Reader band | DS-COMP-34 Journey map | reader band with 3px state rule |
| AG-A8 | Stage head ×7 | DS-COMP-34 Journey map | stage head part |
| AG-A9 | Journey line | DS-COMP-34 Journey map | stage-line part; chose map over plain rule |
| AG-A10 | Activation node | DS-COMP-34 Journey map | node part |
| AG-A11 | Empty stage | DS-PRIM-28 Empty state | empty stage, inline |
| AG-A12 | Ops row | DS-COMP-34 Journey map | ops row part |
### Settings (`/settings/` and six children)

| Id | Element | Component | Note |
|---|---|---|---|
| AG-X20 | Settings card | DS-COMP-26 Form layout | settings rows variant (.set__card) |
| AG-X21 | Setting row ×2 | DS-COMP-13 List row | record row (.setrow); chose row over control |
| AG-X22 | Appearance | DS-PRIM-10 Segmented control and facet | segmented, two options |
| AG-X23 | Guided tips | DS-PRIM-10 Segmented control and facet | segmented with reset button and state line |

## CLIENT.md

### The Brief (overview)

| Id | Element | Component | Note |
|---|---|---|---|
| BR-01 | Hero | DS-COMP-31 Hero | home hero variant, cover slot and client mark |
| BR-02 | Edit cover | DS-PRIM-1 Button | icon plus label button on hero paint |
| BR-03 | "Needs a call" chip | DS-PRIM-15 Status mark (text and chip) | outline warn chip states the relationship state |
| BR-04 | Renewal chip | DS-PRIM-25 Marker, tag, stamp, index and freshness | marker voice, not a real chip |
| BR-05 | Last-touch chip | DS-PRIM-25 Marker, tag, stamp, index and freshness | marker voice, not a real chip |
| BR-06 | Lead chip | DS-PRIM-25 Marker, tag, stamp, index and freshness | marker voice, not a real chip |
| BR-07 | Alerts strip head | DS-COMP-5 Tip and alert strips (placement) | alerts list head; the whole strip is the composite |
| BR-08 | Alert row | DS-COMP-5 Tip and alert strips (placement) | alerts list row inside the alerts strip |
| BR-09 | Dismiss | DS-PRIM-1 Button | text-only ghost button |
| BR-10 | Ask / task icons | DS-PRIM-2 Icon button (including close ×) | ask and task icon buttons |
| BR-11 | Detail chevron | DS-PRIM-31 Disclosure chevron | row detail chevron |
| BR-12 | Dismiss confirm | DS-COMP-25 Modal, sheet and drawer | inline confirm, the house pattern in place of a modal |
| BR-13 | Meeting card title | DS-COMP-32 Meeting card | meeting card title with rule divider |
| BR-14 | Meeting facts | DS-COMP-32 Meeting card | meeting kind, time and meta rows |
| BR-15 | Manage booking | DS-PRIM-1 Button | secondary small |
| BR-16 | Book a meeting | DS-PRIM-1 Button | secondary small with calendar icon |
| BR-17 | Booking pop-out | DS-PRIM-19 Menu and popover | booking pop-out panel with head and close |
| BR-18 | Booking: title | DS-PRIM-3 Text input | borderless title input |
| BR-19 | Booking: Day | DS-PRIM-5 Select | date picker trigger drawn as the house select |
| BR-20 | Booking: Time | DS-PRIM-5 Select | time picker trigger (.dp__btn) opening a pop |
| BR-21 | Slot grid | DS-COMP-38 Calendar and date grid | slot grid variant (remapped by the Astra cross-check) |
| BR-22 | Booking: Length | DS-PRIM-5 Select | select |
| BR-23 | Booking: Guests | DS-PRIM-5 Select | guests select; add-guest is a button beside it |
| BR-24 | Booking: Kind, Where | DS-PRIM-5 Select | two selects |
| BR-25 | Booking: Notes | DS-PRIM-4 Textarea | two-row textarea |
| BR-26 | Booking: summary + Send | DS-COMP-26 Form layout | booking form foot: read-back plus primary action |
| BR-27 | §001 head | DS-COMP-4 Section head | numbered with right marker |
| BR-28 | Section tip | DS-COMP-5 Tip and alert strips (placement) | section tip placement |
| BR-29 | Verdict strip head | DS-COMP-9 Verdict strip | strip head: headline and period |
| BR-30 | Verdict row ×4 (bare) | DS-COMP-9 Verdict strip | bare verdict rows |
| BR-31 | L2 layer "Where the enquiry count comes from" | DS-COMP-12 Disclosure layer | L2 layer, shut |
| BR-32 | §002 head + tip | DS-COMP-4 Section head | numbered head with tip |
| BR-33 | Brief card | DS-COMP-7 Card (content and list card) | padded content card; candidate was base only |
| BR-34 | Brief stamp + by-line | DS-PRIM-25 Marker, tag, stamp, index and freshness | stamp and by-line |
| BR-35 | Listen | DS-PRIM-2 Icon button (including close ×) | icon-only listen action |
| BR-36 | Brief ask icon | DS-PRIM-2 Icon button (including close ×) | ask icon button |
| BR-37 | Client read | DS-COMP-6 Stat row | two figures in a row; fold .cread into stat row per drift |
| BR-38 | Headline | `content` | headline copy in a type style, no component look |
| BR-39 | Fix-first block | DS-COMP-5 Tip and alert strips (placement) | worst-alert detail of the alerts strip; no closer composite |
| BR-40 | Week label | DS-PRIM-25 Marker, tag, stamp, index and freshness | mono week label over a rule |
| BR-41 | SWOT quadrant ×4 | DS-COMP-13 List row | .swot rows under quadrant labels |
| BR-42 | "What they were sent this week →" | DS-PRIM-26 Link and door link | plain link |
| BR-43 | The long version | DS-COMP-12 Disclosure layer | disclosure of the long version, not just the chevron |
| BR-44 | Ask cards ×3 | DS-COMP-8 Door card | ask card variant |
| BR-45 | Ask box | DS-COMP-26 Form layout | ask box (askBox) listed under form layout |
| BR-46 | Suggestion chips ×4 | DS-PRIM-11 Chip and pill | suggestion chips |
| BR-47 | Read everything | DS-PRIM-1 Button | secondary small with icon; note is copy |
| BR-48 | Not-sent note | DS-PRIM-25 Marker, tag, stamp, index and freshness | mono note |
| BR-49 | §003 head + tip | DS-COMP-4 Section head | numbered head with tip |
| BR-50 | Timeline card head | DS-COMP-7 Card (content and list card) | chart card head holding the Gantt |
| BR-51 | Gantt axis | DS-COMP-30 Project timeline (Gantt) | week axis and today label |
| BR-52 | Gantt row ×6 | DS-COMP-30 Project timeline (Gantt) | project bar rows |
| BR-53 | Out-of-window note | DS-COMP-30 Project timeline (Gantt) | timeline foot note on undrawn projects |
| BR-54 | §004 head, tip, lede | DS-COMP-4 Section head | numbered head with tip and lede |
| BR-55 | L2 "The relationship record" | DS-COMP-12 Disclosure layer | L2 layer, shut |
| BR-56 | L2 "The numbers" | DS-COMP-12 Disclosure layer | L2 layer, shut |
| BR-57 | L2 "The work, and the money" | DS-COMP-12 Disclosure layer | L2 layer, shut |
| BR-58 | L2 "Plumbing and history" | DS-COMP-12 Disclosure layer | L2 layer, shut |
### The recommendation card (recCard), shared by both reports › Every slot, in order

| Id | Element | Component | Note |
|---|---|---|---|
| RC-01 | Card frame | DS-COMP-11 Recommendation card | card frame with accent left rule |
| RC-02 | Head (optional, `state: true` default) | DS-COMP-11 Recommendation card | head with kind tag and status marker |
| RC-03 | Title | DS-COMP-11 Recommendation card | title slot |
| RC-04 | Three-up grid | DS-COMP-11 Recommendation card | three-up body grid |
| RC-05 | Predicted | DS-COMP-11 Recommendation card | predicted slot |
| RC-06 | Prior block | DS-COMP-11 Recommendation card | priors block (.prior) |
| RC-07 | Respond row | DS-COMP-11 Recommendation card | actions row |
| RC-08 | Approved receipt | DS-PRIM-15 Status mark (text and chip) | approved state in words, success colour |
| RC-09 | Discuss panel | DS-COMP-26 Form layout | inline reply form inside the card |
| RC-10 | Send to <owner> | DS-PRIM-1 Button | primary small |
| RC-11 | Book a call instead | DS-PRIM-1 Button | ghost |
### Weekly report

| Id | Element | Component | Note |
|---|---|---|---|
| WK-01 | Week picker | DS-PRIM-1 Button | secondary small with caret, report control |
| WK-02 | Download PDF | DS-PRIM-1 Button | secondary small |
| WK-03 | Edit this report / Done editing | DS-PRIM-1 Button | secondary small toggle, agency only |
| WK-04 | Draft control (`#sendState.repctl`) | DS-COMP-3 Page header | report variant: draft state control (.repctl) |
| WK-05 | Uncommitted bar | DS-COMP-3 Page header | report variant: uncommitted state with commit button |
| WK-06 | FROZEN SUNDAY chip | DS-PRIM-11 Chip and pill | outline term chip with tooltip |
| WK-07 | Draft gate (body) | DS-COMP-5 Tip and alert strips (placement) | .draftgate strip, print only |
| WK-08 | By-line | DS-PRIM-25 Marker, tag, stamp, index and freshness | u-tag by-line |
| WK-09 | Verdict | DS-PRIM-15 Status mark (text and chip) | success status chip; the sentence is editable copy |
| WK-10 | Hero number | DS-COMP-31 Hero | report hero with big figure |
| WK-11 | Pace meter | DS-PRIM-23 Meter and progress | progress to target meter with label and state |
| WK-12 | Sparkline | DS-COMP-29 Inline chart (sparkline, bar list, band track) | sparkline with area and month axis |
| WK-13 | Verdict strip (full) | DS-COMP-9 Verdict strip | full variant |
| WK-14 | Client call-to-action | DS-COMP-8 Door card | cta strip variant, client only |
| WK-15 | L2 "Where these numbers come from" | DS-COMP-12 Disclosure layer | L2 layer, shut |
| WK-16 | Recommendation section head | DS-COMP-4 Section head | bare u-tag head, report drift |
| WK-17 | recCard | DS-COMP-11 Recommendation card | needs decision |
| WK-18 | Enquiries head | DS-COMP-4 Section head | bare u-tag head, report drift |
| WK-19 | Outcome nudge | DS-COMP-5 Tip and alert strips (placement) | warning nudge strip |
| WK-20 | Feed row ×5 | DS-COMP-14 Feed and ledger | enquiry feed rows |
| WK-21 | See all | DS-PRIM-1 Button | secondary small; note is copy |
| WK-22 | Sources bars ×5 | DS-COMP-29 Inline chart (sparkline, bar list, band track) | bar list |
| WK-23 | Handoff | DS-COMP-8 Door card | cta strip variant (.handoff) |
### Monthly report

| Id | Element | Component | Note |
|---|---|---|---|
| MO-01 | Header meta | DS-COMP-3 Page header | report variant meta slot |
| MO-02 | Section tip | DS-COMP-5 Tip and alert strips (placement) | section tip placement |
| MO-03 | Cover | DS-COMP-37 Report layouts | monthly chapters cover |
| MO-04 | Client CTA | DS-COMP-8 Door card | cta strip variant, client only |
| MO-05 | 001 The short version | DS-COMP-9 Verdict strip | full strip; prose is copy |
| MO-06 | 002 Your targets, scored | DS-PRIM-20 Table and cells | scorecard table in a flush card |
| MO-07 | 003 What happened, and why | DS-COMP-27 Axis chart (line, column) | line chart card with markers and legend |
| MO-08 | 004 Where your money went | DS-PRIM-20 Table and cells | sources table; prose is copy |
| MO-09 | 005 What we said would happen | DS-COMP-13 List row | page rows |
| MO-10 | 006 Our recommendations | DS-COMP-11 Recommendation card | three cards |
| MO-11 | 007 What we're doing next | DS-COMP-13 List row | page rows |
| MO-12 | 008 Notes on these numbers | DS-COMP-37 Report layouts | caveat annotations, listed in report layouts |
| MO-13 | Edit mode | DS-COMP-37 Report layouts | monthly chapter edit bars and tray |
| MO-14 | Uncommitted bar and draft control | DS-COMP-3 Page header | report variant meta slot |
### Track record

| Id | Element | Component | Note |
|---|---|---|---|
| TR-01 | Sync marker | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker |
| TR-02 | Page tip | DS-COMP-5 Tip and alert strips (placement) | page tip |
| TR-03 | 001 The scoreboard | DS-COMP-4 Section head | numbered with tip |
| TR-04 | Verdict strip | DS-COMP-9 Verdict strip | full variant with sentences |
| TR-05 | Stat row (`g4`) | DS-COMP-6 Stat row | g4, no deltas |
| TR-06 | Attribution line | `content` | attribution sentence, plain copy |
| TR-07 | 002 Said vs happened | DS-COMP-13 List row | said vs happened rows; head is DS-COMP-4 |
| TR-08 | 003 Where this feeds | DS-COMP-8 Door card | card door variant |
### Library ▸ Brand

| Id | Element | Component | Note |
|---|---|---|---|
| BD-01 | Download brand kit | DS-PRIM-1 Button | secondary small, unwired |
| BD-02 | Logo card head | DS-COMP-7 Card (content and list card) | card head with action |
| BD-03 | Logo variant ×3 | DS-COMP-7 Card (content and list card) | logo tile card with art and buttons |
| BD-04 | Typography card | DS-COMP-7 Card (content and list card) | padded card |
| BD-05 | Palette card | DS-COMP-7 Card (content and list card) | padded card of swatches |
| BD-06 | Hero photo / Hero video cards | DS-COMP-7 Card (content and list card) | card holding the photo and video tiles with Download; the tiles are DS-COMP-39 (built on; noted by RECONCILE-LOOK) |
### Library ▸ Design system

| Id | Element | Component | Note |
|---|---|---|---|
| DSY-01 | Sync marker | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker |
| DSY-02 | 001 head | DS-COMP-4 Section head | numbered |
| DSY-03 | Preview frame | `content` | sandboxed iframe of client HTML, no own look |
| DSY-04 | Frame note | `content` | explanatory copy line |
| DSY-05 | The file: meta grid | DS-COMP-13 List row | record row variant: key and value grid |
| DSY-06 | Note | DS-PRIM-22 Banner and tip | note strip with left rule inside a card |
| DSY-07 | Drive path | DS-PRIM-26 Link and door link | Drive path meant as a link, unwired |
| DSY-08 | Replace it: note field | DS-PRIM-4 Textarea | mono textarea with label |
| DSY-09 | Drop zone | DS-COMP-26 Form layout | file drop field in the replace form |
| DSY-10 | 003 head | DS-COMP-4 Section head | numbered with tip |
| DSY-11 | Version row ×3 | DS-COMP-13 List row | page rows with trailing chip or button |
| DSY-12 | Drive icon | DS-PRIM-2 Icon button (including close ×) | icon-only open action |
### Library ▸ Voice

| Id | Element | Component | Note |
|---|---|---|---|
| VO-01 | 001 head | DS-COMP-4 Section head | numbered |
| VO-02 | Lever card ×9 | DS-COMP-7 Card (content and list card) | lever card; not a door per DS-COMP-8 drift |
| VO-03 | 002 head | DS-COMP-4 Section head | numbered; notes card follows |
| VO-04 | Note row ×5 | DS-COMP-15 Message thread and composer | voice note messages (.msg.vnote) |
| VO-05 | Remove × | DS-PRIM-2 Icon button (including close ×) | remove ×, unstyled defect |
| VO-06 | Composer | DS-COMP-26 Form layout | inline form (voiceNoteForm) |
| VO-07 | 003 head | DS-COMP-4 Section head | numbered, agency only |
| VO-08 | Form row ×5 | DS-COMP-13 List row | page rows with door links |
### Library ▸ Drive

| Id | Element | Component | Note |
|---|---|---|---|
| DR-01 | Open in Google Drive ↗ | DS-PRIM-1 Button | secondary small, unwired |
| DR-02 | Starred files ×4 | DS-COMP-7 Card (content and list card) | drive item tiles in a card; not doors |
| DR-03 | Folders ×6 | DS-COMP-7 Card (content and list card) | drive item tiles in a card; not doors |
| DR-04 | Recent files ×8 | DS-COMP-7 Card (content and list card) | drive item tiles in a card; Upload in head |
### Docs (home, shared, favourites, trash)

| Id | Element | Component | Note |
|---|---|---|---|
| DOC-01 | `/docs/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
| DOC-02 | `/docs/shared/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
| DOC-03 | `/docs/favourites/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
| DOC-04 | `/docs/trash/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
### Forms (home, submissions, content editor, preview and embed)

| Id | Element | Component | Note |
|---|---|---|---|
| FM-01 | `/forms/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
| FM-02 | `/forms/submissions/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
| FM-03 | `/forms/content-editor/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
| FM-04 | `/forms/preview-embed/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
### Account (invoices, ad hoc hours, business details, plan, settings) › Invoices (`AC-INV`)

| Id | Element | Component | Note |
|---|---|---|---|
| AC-01 | Stat ×4 | DS-COMP-6 Stat row | g4 money stats |
| AC-02 | Account bar | DS-COMP-29 Inline chart (sparkline, bar list, band track) | stacked account bar with legend |
| AC-03 | Last invoice card | DS-COMP-7 Card (content and list card) | padded card with spread rows and actions |
| AC-04 | Recent invoices table | DS-PRIM-20 Table and cells | dense table |
| AC-05 | Export CSV | DS-PRIM-1 Button | secondary small, unwired |
### Account (invoices, ad hoc hours, business details, plan, settings) › Ad hoc hours (`AC-AH`)

| Id | Element | Component | Note |
|---|---|---|---|
| AC-06 | Stats ×4 | DS-COMP-6 Stat row | g4; raw .stat to drop |
| AC-07 | Hours table | DS-PRIM-20 Table and cells | dense table |
| AC-08 | Rates card | DS-COMP-7 Card (content and list card) | padded card with spread rows |
| AC-09 | Export CSV | DS-PRIM-1 Button | secondary small, unwired |
### Account (invoices, ad hoc hours, business details, plan, settings) › Business details (`AC-BD`)

| Id | Element | Component | Note |
|---|---|---|---|
| AC-10 | Business details | DS-COMP-13 List row | record rows with edit mode |
| AC-11 | Your team | DS-COMP-13 List row | people rows (peopleList) |
| AC-12 | Moved-settings line | `content` | copy line; its link is DS-PRIM-26 |
| AC-13 | Service plan | DS-COMP-7 Card (content and list card) | padded card with spread rows |
| AC-14 | Service agreement | DS-COMP-7 Card (content and list card) | padded card with chip and buttons |
| AC-15 | Contact banner | DS-COMP-5 Tip and alert strips (placement) | info notice, not dismissable |
### Account (invoices, ad hoc hours, business details, plan, settings) › Your plan (`AC-PL`)

| Id | Element | Component | Note |
|---|---|---|---|
| AC-16 | Tier card ×4 | DS-COMP-7 Card (content and list card) | tier card |
| AC-17 | CTA bar | DS-COMP-8 Door card | cta strip variant (.plans__cta) |
### Account (invoices, ad hoc hours, business details, plan, settings) › Settings (`AC-ST`)

| Id | Element | Component | Note |
|---|---|---|---|
| AC-18 | Appearance | DS-PRIM-10 Segmented control and facet | segmented control as drawn |
| AC-19 | Guided tips | DS-PRIM-10 Segmented control and facet | segmented control plus Reset |

## WORKBENCH.md

The workbench inventory's `SH-` ids below are the same ids `PLACEHOLDERS.md` re-keys as `WSH-` (so they never collide with SHELL's `SH-`). The map is in `evidence/RECONCILE-CAPABILITY.md`.

### What every surface shares › Page chrome around every tab (measured, 1480 light)

| Id | Element | Component | Note |
|---|---|---|---|
| WSH-01 | Tab bar `nav.tabbar` | DS-COMP-2 Tab row and tab mark | tab row under the strip |
| WSH-02 | Page title `#sectionTitle` | DS-COMP-3 Page header | page title with source favicons |
| WSH-03 | Freshness `button.fresh` "41M AGO" | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness variant, page header meta slot |
| WSH-04 | Share button | DS-PRIM-1 Button | secondary sm, page header control |
| WSH-05 | Period pill "1 – 6 Aug 2026 ▾" | DS-PRIM-1 Button | secondary sm with chevron; opens period picker |
| WSH-06 | Tab tip `.banner.banner--info.sectip` | DS-PRIM-22 Banner and tip | tip variant; the strip itself, placement is DS-COMP-5 |
### What every surface shares › Shared components (one spec, used on many tabs)

| Id | Element | Component | Note |
|---|---|---|---|
| WSH-10 | Verdict strip `section.vstrip` | DS-COMP-9 Verdict strip | verdict strip, canonical |
| WSH-11 | Verdict row `.vrow` | DS-COMP-9 Verdict strip | verdict row part of the strip |
| WSH-12 | Band track `.band` | DS-COMP-29 Inline chart (sparkline, bar list, band track) | band track variant |
| WSH-13 | Ask sparkle `button.askbtn` | DS-PRIM-2 Icon button (including close ×) | ask sparkle icon button |
| WSH-14 | Task icon | DS-PRIM-2 Icon button (including close ×) | create-task icon button |
| WSH-15 | Next-move slot `.toprec` | DS-COMP-10 Finding card | finding with pager (next-move slot) |
| WSH-16 | Finding card `.ai` (`aiCard`, `ui.js:647-692`) | DS-COMP-10 Finding card | finding variant, canonical |
| WSH-17 | Channel flag `a.chanflag` | DS-COMP-8 Door card | row door (.chanflag); whole strip is a link |
| WSH-18 | Layer `details.layer` | DS-COMP-12 Disclosure layer | disclosure layer, canonical |
| WSH-19 | KPI row `.statrow.gN` with `.stat` tiles (`kpiSm`, `ui.js:124-150`) | DS-COMP-6 Stat row | stat row of KPI tiles |
| WSH-20 | Table (`table()`, `ui.js:253-259`) | DS-PRIM-20 Table and cells | table, sortable heads |
| WSH-21 | Bar list (`bars`, `ui.js:573-584`) | DS-COMP-29 Inline chart (sparkline, bar list, band track) | bar list variant; candidate only named the tooltip |
| WSH-22 | Meter (`meter`, `ui.js:202-211`) | DS-PRIM-23 Meter and progress | meter |
| WSH-23 | "Where this number comes from" (`sourceRows`, `ui.js:1424-1455`) | DS-COMP-33 Source rows | source rows, canonical |
| WSH-24 | Source link `a.chlink` | DS-PRIM-26 Link and door link | source link, dotted underline |
| WSH-25 | Opportunity row `details.opp` (`oppRow`, `ui.js:2506-2519`) | DS-COMP-13 List row | page row with disclosure (oppRow) |
| WSH-26 | Pink mock overlay `.is-mock` | DS-PRIM-32 Mock-data mark | kept in demo installs by R56 (remapped by the Astra cross-check; was `content`) |
| WSH-27 | Unwired hatch `[data-unwired]` | `content` | unwired hatch is a port instruction, not ported (DS-X4) |
| WSH-30 | `lineChart` (`charts.js:47-105`) | DS-COMP-27 Axis chart (line, column) | line variant |
| WSH-31 | `columnChart` (`charts.js:107-161`) | DS-COMP-27 Axis chart (line, column) | column variant |
| WSH-32 | `donut` (`charts.js:163-189`) | DS-COMP-28 Radial chart (donut, gauge, score dial) | donut variant |
| WSH-33 | `gauge` (`charts.js:191-228`) | DS-COMP-28 Radial chart (donut, gauge, score dial) | gauge variant |
| WSH-34 | `scoreDial` (`charts.js:297-318`) | DS-COMP-28 Radial chart (donut, gauge, score dial) | score dial variant |
### Connections

| Id | Element | Component | Note |
|---|---|---|---|
| CN-W01 | Problem banner (`problemBanner`, `connections.js:183`) | DS-PRIM-22 Banner and tip | banner, bad or warning tone |
| CN-W02 | Status cell | DS-PRIM-15 Status mark (text and chip) | status mark, text variant in a cell |
| CN-W03 | Source cell | DS-PRIM-20 Table and cells | name cell with sub-line |
| CN-W04 | Last synced | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness stamp toned by age; the cell is the stamp |
| CN-W05 | Quota burn | DS-PRIM-23 Meter and progress | meter plus number in a cell |
| CN-W06 | Note | `content` | one-line note text, a data value |
| CN-W07 | Sync cell | DS-PRIM-1 Button | secondary sm Sync, busy state |
| CN-W08 | Head controls | DS-PRIM-20 Table and cells | sortable heads plus expand toggle |
| CN-W09 | Detail: sync history | DS-COMP-14 Feed and ledger | ledger of sync attempts |
| CN-W10 | Detail: credential and custody | DS-PRIM-20 Table and cells | expanded-row detail block; no detail component, nearest |
| CN-W11 | Detail: components, feeds, notes | DS-COMP-26 Form layout | panel form: notes textarea and save |
| CN-W12 | Foot card | DS-COMP-8 Door card | card door, foot card to Connections |
| CN-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| CN-M02 | button | DS-PRIM-2 Icon button (including close ×) | expand-all double-chevron toggle |
| CN-M03 | button | DS-PRIM-1 Button | secondary sm |
| CN-M04 | a | DS-PRIM-26 Link and door link | inline link |
| CN-M05 | button | DS-PRIM-1 Button | secondary sm |
| CN-M06 | a | DS-PRIM-1 Button | secondary sm rendered as a link |
| CN-M07 | th | DS-PRIM-20 Table and cells | sortable head cell |
| CN-M08 | tr | DS-PRIM-20 Table and cells | body row |
| CN-M09 | tr | DS-PRIM-20 Table and cells | body row |
| CN-M10 | tr | DS-PRIM-20 Table and cells | body row |
| CN-M11 | tr | DS-PRIM-20 Table and cells | body row |
| CN-M12 | tr | DS-PRIM-20 Table and cells | body row |
| CN-M13 | tr | DS-PRIM-20 Table and cells | body row |
| CN-M14 | tr | DS-PRIM-20 Table and cells | body row |
| CN-M15 | tr | DS-PRIM-20 Table and cells | body row |
| CN-M16 | tr | DS-PRIM-20 Table and cells | body row |
| CN-M17 | tr | DS-PRIM-20 Table and cells | body row |
| CN-M18 | tr | DS-PRIM-20 Table and cells | body row |
| CN-M19 | tr | DS-PRIM-20 Table and cells | body row |
| CN-M20 | tr | DS-PRIM-20 Table and cells | body row |
| CN-M21 | tr | DS-PRIM-20 Table and cells | body row |
| CNX-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| CNX-M02 | button | DS-PRIM-2 Icon button (including close ×) | expand-all double-chevron toggle |
| CNX-M03 | button | DS-PRIM-1 Button | secondary sm |
| CNX-M04 | a | DS-PRIM-26 Link and door link | inline link |
| CNX-M05 | button | DS-PRIM-1 Button | secondary sm |
| CNX-M06 | button | DS-PRIM-1 Button | secondary sm |
| CNX-M07 | a | DS-PRIM-1 Button | secondary sm rendered as a link |
| CNX-M08 | button | DS-PRIM-1 Button | secondary sm |
| CNX-M09 | textarea | DS-PRIM-4 Textarea | notes field |
| CNX-M10 | button | DS-PRIM-1 Button | secondary sm |
| CNX-M11 | a | DS-PRIM-1 Button | secondary sm rendered as a link |
| CNX-M12 | th | DS-PRIM-20 Table and cells | sortable head cell |
| CNX-M13 | tr | DS-PRIM-20 Table and cells | body row |
| CNX-M14 | tr | DS-PRIM-20 Table and cells | body row |
| CNX-M15 | tr | DS-PRIM-20 Table and cells | body row |
| CNX-M16 | tr | DS-PRIM-20 Table and cells | body row |
| CNX-M17 | tr | DS-PRIM-20 Table and cells | body row |
| CNX-M18 | tr | DS-PRIM-20 Table and cells | body row |
| CNX-M19 | tr | DS-PRIM-20 Table and cells | body row |
| CNX-M20 | tr | DS-PRIM-20 Table and cells | body row |
| CNX-M21 | tr | DS-PRIM-20 Table and cells | body row |
| CNX-M22 | tr | DS-PRIM-20 Table and cells | body row |
| CNX-M23 | tr | DS-PRIM-20 Table and cells | body row |
| CNX-M24 | tr | DS-PRIM-20 Table and cells | body row |
| CNX-M25 | tr | DS-PRIM-20 Table and cells | body row |
| CNX-M26 | tr | DS-PRIM-20 Table and cells | body row |
### Traffic & landing

| Id | Element | Component | Note |
|---|---|---|---|
| TL-W01 | L1 strip | DS-COMP-9 Verdict strip | L1 verdict strip |
| TL-W02 | Next move | DS-COMP-10 Finding card | finding with pager (next move) |
| TL-W03 | KPI row `g4` | DS-COMP-6 Stat row | stat row g4 |
| TL-W04 | Most-viewed pages table | DS-PRIM-20 Table and cells | table in a flush card |
| TL-W05 | Traffic sources donut | DS-COMP-28 Radial chart (donut, gauge, score dial) | donut variant in a chart card |
| TL-W06 | Corroboration | DS-COMP-33 Source rows | source rows with divergence banner |
| TL-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| TL-M02 | a | DS-PRIM-26 Link and door link | source link, mono voice |
| TL-M03 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| TL-M04 | button | DS-PRIM-2 Icon button (including close ×) | create-task icon |
| TL-M05 | button | DS-PRIM-1 Button | secondary sm |
| TL-M06 | button | DS-PRIM-1 Button | secondary sm |
| TL-M07 | button | DS-PRIM-1 Button | secondary sm |
| TL-M08 | button | DS-PRIM-1 Button | secondary sm |
| TL-M09 | summary | DS-COMP-12 Disclosure layer | layer summary row |
| TL-M10 | th | DS-PRIM-20 Table and cells | sortable head cell |
### On-page behaviour

| Id | Element | Component | Note |
|---|---|---|---|
| OB-W01 | Snapshot strip | DS-COMP-9 Verdict strip | verdict strip with no rows, empty-state banner |
| OB-W02 | Channel flag | DS-COMP-8 Door card | row door (.chanflag) |
| OB-W03 | KPI row `g4` | DS-COMP-6 Stat row | stat row g4, no deltas |
| OB-W04 | Behaviour signals table | DS-PRIM-20 Table and cells | table |
| OB-W05 | "What this feed can prove" | DS-COMP-7 Card (content and list card) | padded card of stacked statements |
| OB-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| OB-M02 | a | DS-PRIM-26 Link and door link | source link, mono voice |
| OB-M03 | button | DS-PRIM-1 Button | secondary sm |
| OB-M04 | button | DS-PRIM-1 Button | secondary sm |
| OB-M05 | button | DS-PRIM-1 Button | secondary sm |
| OB-M06 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| OB-M07 | a | DS-COMP-8 Door card | row door (.chanflag) |
| OB-M08 | summary | DS-COMP-12 Disclosure layer | layer summary row |
| OB-M09 | th | DS-PRIM-20 Table and cells | sortable head cell |
### Forms (hidden for every tenant)

| Id | Element | Component | Note |
|---|---|---|---|
| FM-W01 | L1 | DS-COMP-9 Verdict strip | L1 verdict strip |
| FM-W02 | KPI row | DS-COMP-6 Stat row | stat row |
| FM-W03 | Forms inventory table | DS-PRIM-20 Table and cells | table with name cells and status marks |
| FM-W04 | Booking form step funnel | DS-PRIM-23 Meter and progress | stack of meters, one per step |
| FM-W05 | Phones vs desktop | DS-COMP-29 Inline chart (sparkline, bar list, band track) | bar list variant, two bars per form |
| FM-W06 | Field errors table | DS-PRIM-20 Table and cells | table |
| FM-W07 | Elements fighting users | DS-COMP-7 Card (content and list card) | list card of literal rows |
| FM-W08 | What sessions show | DS-COMP-13 List row | page rows tagged SESSION; no candidate, list rows fit |
| FM-W09 | Exit points table | DS-PRIM-20 Table and cells | table |
| FM-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| FM-M02 | a | DS-PRIM-26 Link and door link | source link, mono voice |
| FM-M03 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| FM-M04 | button | DS-PRIM-2 Icon button (including close ×) | create-task icon |
| FM-M05 | button | DS-PRIM-1 Button | secondary sm |
| FM-M06 | button | DS-PRIM-1 Button | secondary sm |
| FM-M07 | button | DS-PRIM-1 Button | secondary sm |
| FM-M08 | button | DS-PRIM-1 Button | secondary sm |
| FM-M09 | summary | DS-COMP-12 Disclosure layer | layer summary row |
| FM-M10 | span | DS-PRIM-18 Tooltip and callout | term with dotted underline, stat label |
| FM-M11 | span | DS-PRIM-18 Tooltip and callout | term with dotted underline, stat label |
| FM-M12 | span | DS-PRIM-18 Tooltip and callout | term with dotted underline, stat label |
| FM-M13 | span | DS-PRIM-18 Tooltip and callout | term with dotted underline, stat label |
| FM-M14 | th | DS-PRIM-20 Table and cells | sortable head cell |
### Search & SEO

| Id | Element | Component | Note |
|---|---|---|---|
| SS-W01 | L1 | DS-COMP-9 Verdict strip | L1 verdict strip |
| SS-W02 | Clicks & impressions chart | DS-COMP-27 Axis chart (line, column) | line variant in a chart card |
| SS-W03 | Ranking distribution | DS-COMP-29 Inline chart (sparkline, bar list, band track) | bar list variant |
| SS-W04 | Corroboration | DS-COMP-33 Source rows | source rows |
| SS-W05 | Cross-link card | DS-COMP-8 Door card | card door, cross-link card |
| SS-W06 | L3 Tracked keywords table | DS-PRIM-20 Table and cells | table |
| SS-W07 | L3 not-measured footer | DS-PRIM-22 Banner and tip | banner, not-measured footer |
| SS-W08 | L3 Search queries table | DS-PRIM-20 Table and cells | table, warning banner follows |
| SS-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| SS-M02 | a | DS-PRIM-26 Link and door link | source link, mono voice |
| SS-M03 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| SS-M04 | button | DS-PRIM-2 Icon button (including close ×) | create-task icon |
| SS-M05 | button | DS-PRIM-1 Button | secondary sm |
| SS-M06 | button | DS-PRIM-1 Button | secondary sm |
| SS-M07 | button | DS-PRIM-1 Button | secondary sm |
| SS-M08 | a | DS-COMP-8 Door card | row door (.chanflag) |
| SS-M09 | summary | DS-COMP-12 Disclosure layer | layer summary row |
| SS-M10 | a | DS-PRIM-26 Link and door link | inline link |
| SS-M11 | th | DS-PRIM-20 Table and cells | sortable head cell |
| SS3-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| SS3-M02 | a | DS-PRIM-26 Link and door link | source link, mono voice |
| SS3-M03 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| SS3-M04 | button | DS-PRIM-2 Icon button (including close ×) | create-task icon |
| SS3-M05 | button | DS-PRIM-1 Button | secondary sm |
| SS3-M06 | button | DS-PRIM-1 Button | secondary sm |
| SS3-M07 | button | DS-PRIM-1 Button | secondary sm |
| SS3-M08 | a | DS-COMP-8 Door card | row door (.chanflag) |
| SS3-M09 | summary | DS-COMP-12 Disclosure layer | layer summary row |
| SS3-M10 | a | DS-PRIM-26 Link and door link | inline link |
| SS3-M11 | th | DS-PRIM-20 Table and cells | sortable head cell |
### Search intent (the creation board)

| Id | Element | Component | Note |
|---|---|---|---|
| SI-W01 | Opportunity board (`keywordOppBoard`, `ui.js:2650`) | DS-COMP-13 List row | page rows with disclosure and column head; not a board |
| SI-W02 | Opened row (capture `search-intent--row-open`) | DS-COMP-10 Finding card | opened row body is a finding card; outermost distinctive part |
| SI-W03 | Authority note | `content` | plain text-2 paragraph, no own look |
| SI-W04 | Batch build console (`batchConsole`, `ui.js:7236-7367`) | DS-COMP-26 Form layout | inline form (batch console) in a card |
| SI-W05 | Intent KPIs `g4` | DS-COMP-6 Stat row | stat row g4 with of-tracks |
| SI-W06 | Intent mix | DS-PRIM-23 Meter and progress | three meters |
| SI-W07 | Ranked, but not where the clicks are | DS-COMP-13 List row | page rows with status marks |
| SI-W08 | What people actually search | DS-COMP-13 List row | page rows under a warning banner |
| SI-W09 | Spend on the wrong intent | DS-PRIM-20 Table and cells | table |
| SI-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| SI-M02 | a | DS-PRIM-26 Link and door link | source link, mono voice |
| SI-M03 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| SI-M04 | button | DS-PRIM-2 Icon button (including close ×) | create-task icon |
| SI-M05 | button | DS-PRIM-1 Button | secondary sm |
| SI-M06 | button | DS-PRIM-1 Button | secondary sm |
| SI-M07 | button | DS-PRIM-1 Button | secondary sm |
| SI-M08 | button | DS-PRIM-1 Button | secondary sm |
| SI-M09 | summary | DS-COMP-12 Disclosure layer | layer summary row |
| SI-M10 | button | DS-PRIM-1 Button | secondary sm, label not captured |
| SI-M11 | button | DS-PRIM-5 Select | house select trigger |
| SI-M12 | input | DS-PRIM-3 Text input | text input |
| SI-M13 | button | DS-PRIM-5 Select | house select trigger |
| SI-M14 | button | DS-PRIM-5 Select | house select trigger |
| SI-M15 | button | DS-PRIM-1 Button | primary |
| SI-M16 | a | DS-PRIM-26 Link and door link | inline link |
| SI-M17 | a | DS-PRIM-26 Link and door link | inline link |
| SI-M18 | th | DS-PRIM-20 Table and cells | sortable head cell |
| SIR-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| SIR-M02 | a | DS-PRIM-26 Link and door link | source link, mono voice |
| SIR-M03 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| SIR-M04 | button | DS-PRIM-2 Icon button (including close ×) | create-task icon |
| SIR-M05 | button | DS-PRIM-1 Button | secondary sm |
| SIR-M06 | button | DS-PRIM-1 Button | secondary sm |
| SIR-M07 | button | DS-PRIM-1 Button | secondary sm |
| SIR-M08 | button | DS-PRIM-1 Button | secondary sm |
| SIR-M09 | summary | DS-COMP-12 Disclosure layer | layer summary row |
| SIR-M10 | button | DS-PRIM-1 Button | secondary sm, label not captured |
| SIR-M11 | a | DS-PRIM-26 Link and door link | accent anchor link, label not captured |
| SIR-M12 | button | DS-PRIM-5 Select | house select trigger |
| SIR-M13 | input | DS-PRIM-3 Text input | text input |
| SIR-M14 | button | DS-PRIM-5 Select | house select trigger |
| SIR-M15 | button | DS-PRIM-5 Select | house select trigger |
| SIR-M16 | button | DS-PRIM-1 Button | primary |
| SIR-M17 | a | DS-PRIM-26 Link and door link | inline link |
| SIR-M18 | a | DS-PRIM-26 Link and door link | inline link |
| SIR-M19 | th | DS-PRIM-20 Table and cells | sortable head cell |
### Google Ads

| Id | Element | Component | Note |
|---|---|---|---|
| GA-W01 | Two books (`paidBookL1`, `index.html:681-697`) | DS-COMP-7 Card (content and list card) | two side-by-side cards plus banner; outermost is cards; the tab should open on the L1 verdict strip (DS-COMP-9) as W§9 requires, and the mock planning book is dropped (fresh flag FLAG-8, settled by RECONCILE-LOOK) |
| GA-W02 | Agentic run (`runRail`, `ui.js:7369`) | DS-COMP-7 Card (content and list card) | padded card; station rail is bespoke inside |
| GA-W03 | KPI row `g6` | DS-COMP-6 Stat row | stat row g6 |
| GA-W04 | Spend against genuine enquiries | DS-COMP-27 Axis chart (line, column) | column variant with dashed line series |
| GA-W05 | Campaigns table | DS-PRIM-20 Table and cells | table with status-line name cells |
| GA-W06 | Corroboration | DS-COMP-33 Source rows | source rows |
| GA-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| GA-M02 | a | DS-PRIM-26 Link and door link | source link, mono voice |
| GA-M03 | button | DS-PRIM-1 Button | secondary sm |
| GA-M04 | button | DS-PRIM-1 Button | secondary sm |
| GA-M05 | button | DS-PRIM-1 Button | secondary sm |
| GA-M06 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| GA-M07 | summary | DS-COMP-12 Disclosure layer | layer summary row |
| GA-M08 | span | DS-PRIM-18 Tooltip and callout | term with dotted underline, stat label |
| GA-M09 | span | DS-PRIM-18 Tooltip and callout | term with dotted underline, stat label |
| GA-M10 | span | DS-PRIM-18 Tooltip and callout | term with dotted underline, stat label |
| GA-M11 | button | DS-PRIM-1 Button | secondary sm |
### Meta Ads

| Id | Element | Component | Note |
|---|---|---|---|
| MA-W01 | KPI row `g4` | DS-COMP-6 Stat row | stat row g4 with empty-state banner |
| MA-W02 | Placement | DS-COMP-29 Inline chart (sparkline, bar list, band track) | bar list variant |
| MA-W03 | Ad creative carousel | DS-COMP-7 Card (content and list card) | card holding a scrolling grid of creative cards; the creative cards are DS-COMP-39 `creative art` (built on, per the Astra cross-check) |
| MA-W04 | Restatement banner | DS-PRIM-22 Banner and tip | banner, restatement notice |
| MA-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| MA-M02 | a | DS-PRIM-26 Link and door link | source link, mono voice |
| MA-M03 | button | DS-PRIM-1 Button | secondary sm |
| MA-M04 | button | DS-PRIM-1 Button | secondary sm |
| MA-M05 | button | DS-PRIM-1 Button | secondary sm |
| MA-M06 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| MA-M07 | summary | DS-COMP-12 Disclosure layer | layer summary row |
| MA-M08 | button | DS-PRIM-1 Button | secondary sm |
### Testing (hidden for every tenant)

| Id | Element | Component | Note |
|---|---|---|---|
| TS-W01 | Headline strip | DS-COMP-9 Verdict strip | verdict strip headline, no rows |
| TS-W02 | Hypothesis card | DS-COMP-7 Card (content and list card) | padded card |
| TS-W03 | Variant cards | DS-COMP-7 Card (content and list card) | padded cards with chip and KPIs |
| TS-W04 | Confidence | DS-COMP-7 Card (content and list card) | padded card holding marker, meter, caution |
| TS-W05 | Concluded tests | DS-COMP-7 Card (content and list card) | list card; rows are DS-COMP-13 |
| TS-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| TS-M02 | button | DS-PRIM-1 Button | secondary sm |
| TS-M03 | button | DS-PRIM-1 Button | secondary sm |
| TS-M04 | button | DS-PRIM-1 Button | secondary sm |
| TS-M05 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| TS-M06 | summary | DS-COMP-12 Disclosure layer | layer summary row |
### Local & reviews (hidden until its source is connected; the mockup hides it for one tenant)

| Id | Element | Component | Note |
|---|---|---|---|
| LR-W01 | L1 | DS-COMP-9 Verdict strip | L1 verdict strip |
| LR-W02 | KPI row `g6` | DS-COMP-6 Stat row | stat row g6 |
| LR-W03 | Local rank grid | `content` | dropped: C27 out of scope (CS-13.36); DS-COMP-41 retired (AUDIT-RECONCILE) |
| LR-W04 | What people did | DS-COMP-29 Inline chart (sparkline, bar list, band track) | bar list variant |
| LR-W05 | Reviews | DS-COMP-7 Card (content and list card) | card: two stats plus star bar list; outermost is card |
| LR-W06 | How people found you | DS-PRIM-20 Table and cells | table |
| LR-W07 | Corroboration | DS-COMP-33 Source rows | source rows |
| LR-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| LR-M02 | a | DS-PRIM-26 Link and door link | source link, mono voice |
| LR-M03 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| LR-M04 | button | DS-PRIM-2 Icon button (including close ×) | create-task icon |
| LR-M05 | button | DS-PRIM-1 Button | secondary sm |
| LR-M06 | button | DS-PRIM-1 Button | secondary sm |
| LR-M07 | button | DS-PRIM-1 Button | secondary sm |
| LR-M08 | summary | DS-COMP-12 Disclosure layer | layer summary row |
| LR-M09 | th | DS-PRIM-20 Table and cells | sortable head cell |
### Calls (hidden until its source is connected; the mockup hides it for one tenant)

| Id | Element | Component | Note |
|---|---|---|---|
| CL-W01 | L1 | DS-COMP-9 Verdict strip | L1 verdict strip |
| CL-W02 | KPI row `g6` | DS-COMP-6 Stat row | stat row g6 |
| CL-W03 | Recent calls table | DS-PRIM-20 Table and cells | table with markers and outline chips |
| CL-W04 | Response speed | DS-COMP-28 Radial chart (donut, gauge, score dial) | gauge variant with band rows |
| CL-W05 | Calls by source | DS-COMP-29 Inline chart (sparkline, bar list, band track) | bar list variant |
| CL-W06 | Corroboration | DS-COMP-33 Source rows | source rows |
| CL-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| CL-M02 | a | DS-PRIM-26 Link and door link | source link, mono voice |
| CL-M03 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| CL-M04 | button | DS-PRIM-2 Icon button (including close ×) | create-task icon |
| CL-M05 | button | DS-PRIM-1 Button | secondary sm |
| CL-M06 | button | DS-PRIM-1 Button | secondary sm |
| CL-M07 | button | DS-PRIM-1 Button | secondary sm |
| CL-M08 | button | DS-PRIM-1 Button | secondary sm |
| CL-M09 | summary | DS-COMP-12 Disclosure layer | layer summary row |
| CL-M10 | button | DS-PRIM-1 Button | secondary sm |
| CL-M11 | th | DS-PRIM-20 Table and cells | sortable head cell |
### Email marketing

| Id | Element | Component | Note |
|---|---|---|---|
| EM-W01 | What email actually delivers | DS-COMP-7 Card (content and list card) | padded card: marker, KPIs, banner; outermost is card |
| EM-W02 | L1 | DS-COMP-9 Verdict strip | L1 verdict strip |
| EM-W03 | KPI row `g5` | DS-COMP-6 Stat row | stat row g5 |
| EM-W04 | Campaigns this month | DS-PRIM-20 Table and cells | table in a flush card |
| EM-W05 | The list | DS-COMP-7 Card (content and list card) | list card of spread record rows |
| EM-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| EM-M02 | a | DS-PRIM-26 Link and door link | source link, mono voice |
| EM-M03 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| EM-M04 | button | DS-PRIM-2 Icon button (including close ×) | create-task icon |
| EM-M05 | button | DS-PRIM-1 Button | secondary sm |
| EM-M06 | button | DS-PRIM-1 Button | secondary sm |
| EM-M07 | button | DS-PRIM-1 Button | secondary sm |
| EM-M08 | button | DS-PRIM-1 Button | secondary sm |
| EM-M09 | summary | DS-COMP-12 Disclosure layer | layer summary row |
| EM-M10 | span | DS-PRIM-18 Tooltip and callout | term with dotted underline, stat label |
| EM-M11 | span | DS-PRIM-18 Tooltip and callout | term with dotted underline, stat label |
| EM-M12 | button | DS-PRIM-1 Button | secondary sm |
| EM-M13 | th | DS-PRIM-20 Table and cells | sortable head cell |
### Funnel (hidden until its source is connected; the mockup hides it for one tenant)

| Id | Element | Component | Note |
|---|---|---|---|
| FN-W01 | L1 | DS-COMP-9 Verdict strip | L1 verdict strip |
| FN-W02 | True-scale funnel (`trueFunnel`, `index.html:1005-1052`) | DS-COMP-40 Funnel chart | new id (was DS-COMP-29 as nearest fit; RECONCILE-LOOK) |
| FN-W03 | Where the leak is | DS-COMP-13 List row | page rows with delta markers |
| FN-W04 | Funnel by channel | DS-PRIM-20 Table and cells | table with tfoot |
| FN-W05 | Corroboration | DS-COMP-33 Source rows | source rows |
| FN-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| FN-M02 | a | DS-PRIM-26 Link and door link | source link, mono voice |
| FN-M03 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| FN-M04 | button | DS-PRIM-2 Icon button (including close ×) | create-task icon |
| FN-M05 | button | DS-PRIM-1 Button | secondary sm |
| FN-M06 | button | DS-PRIM-1 Button | secondary sm |
| FN-M07 | button | DS-PRIM-1 Button | secondary sm |
| FN-M08 | a | DS-COMP-8 Door card | row door (.chanflag) |
| FN-M09 | summary | DS-COMP-12 Disclosure layer | layer summary row |
| FN-M10 | th | DS-PRIM-20 Table and cells | sortable head cell |
### Revenue (hidden for every tenant)

| Id | Element | Component | Note |
|---|---|---|---|
| RV-W01 | L1 | DS-COMP-9 Verdict strip | L1 verdict strip with mock tag |
| RV-W02 | KPI row `g4` | DS-COMP-6 Stat row | stat row g4 |
| RV-W03 | Enquiry to revenue | DS-PRIM-23 Meter and progress | five meters |
| RV-W04 | Revenue by channel | DS-PRIM-20 Table and cells | table with ROI markers |
| RV-W05 | Lead quality by source | DS-COMP-13 List row | page rows with status marks |
| RV-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| RV-M02 | a | DS-PRIM-26 Link and door link | source link, mono voice |
| RV-M03 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| RV-M04 | button | DS-PRIM-2 Icon button (including close ×) | create-task icon |
| RV-M05 | button | DS-PRIM-1 Button | secondary sm |
| RV-M06 | button | DS-PRIM-1 Button | secondary sm |
| RV-M07 | button | DS-PRIM-1 Button | secondary sm |
| RV-M08 | summary | DS-COMP-12 Disclosure layer | layer summary row |
| RV-M09 | th | DS-PRIM-20 Table and cells | sortable head cell |
### Website performance

| Id | Element | Component | Note |
|---|---|---|---|
| WP-W01 | L1 | DS-COMP-9 Verdict strip | L1 verdict strip |
| WP-W02 | Lighthouse scores | DS-COMP-28 Radial chart (donut, gauge, score dial) | four score dials in a card |
| WP-W03 | Core Web Vitals | DS-COMP-7 Card (content and list card) | list card of vitals rows |
| WP-W04 | Top opportunities | DS-COMP-7 Card (content and list card) | list card of oppRow disclosure rows |
| WP-W05 | Infrastructure lens | DS-COMP-8 Door card | card door to Site health |
| WP-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| WP-M02 | a | DS-PRIM-26 Link and door link | source link, mono voice |
| WP-M03 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| WP-M04 | button | DS-PRIM-2 Icon button (including close ×) | create-task icon |
| WP-M05 | button | DS-PRIM-1 Button | secondary sm |
| WP-M06 | button | DS-PRIM-1 Button | secondary sm |
| WP-M07 | button | DS-PRIM-1 Button | secondary sm |
| WP-M08 | button | DS-PRIM-1 Button | secondary sm |
| WP-M09 | summary | DS-COMP-12 Disclosure layer | layer summary row |
| WP-M10 | a | DS-PRIM-26 Link and door link | inline link |
| WPO-M01 | button | DS-PRIM-2 Icon button (including close ×) | close ×, dismisses the tab tip |
| WPO-M02 | a | DS-PRIM-26 Link and door link | source link, mono voice |
| WPO-M03 | button | DS-PRIM-2 Icon button (including close ×) | ask sparkle |
| WPO-M04 | button | DS-PRIM-2 Icon button (including close ×) | create-task icon |
| WPO-M05 | button | DS-PRIM-1 Button | secondary sm |
| WPO-M06 | button | DS-PRIM-1 Button | secondary sm |
| WPO-M07 | button | DS-PRIM-1 Button | secondary sm |
| WPO-M08 | button | DS-PRIM-1 Button | secondary sm |
| WPO-M09 | summary | DS-COMP-12 Disclosure layer | layer summary row |
| WPO-M10 | a | DS-PRIM-26 Link and door link | inline link |

## PORTAL.md

### Home

| Id | Element | Component | Note |
|---|---|---|---|
| PH-01 | Sync marker | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker |
| PH-02 | Section tip | DS-COMP-5 Tip and alert strips (placement) | page tip |
| PH-03 | Hero eyebrow | DS-COMP-31 Hero | hero eyebrow |
| PH-04 | Hero name + mark | DS-COMP-31 Hero | hero name and square client mark |
| PH-05 | Hero sub | DS-COMP-31 Hero | hero lede |
| PH-06 | Hero stats ×4 | DS-COMP-31 Hero | hero stats |
| PH-07 | This week card | DS-COMP-7 Card (content and list card) | padded card with stamp |
| PH-08 | Next meeting title | DS-COMP-32 Meeting card | meeting title with rule bar |
| PH-09 | Meeting kind | DS-COMP-32 Meeting card | meeting kind |
| PH-10 | Week strip (`miniCal`) | DS-COMP-38 Calendar and date grid | week strip variant, hosted by DS-COMP-32 (remapped by the Astra cross-check) |
| PH-11 | Meeting meta rows | DS-COMP-32 Meeting card | meeting meta rows |
| PH-12 | Manage booking | DS-PRIM-1 Button | primary large, full width |
| PH-13 | Verdict strip | DS-COMP-9 Verdict strip | full variant |
| PH-14 | askbtn ×3 | DS-PRIM-2 Icon button (including close ×) | ask icon buttons |
| PH-15 | Overview card: In progress | DS-COMP-8 Door card | card door with meters |
| PH-16 | Overview card: Needs your eyes | DS-COMP-8 Door card | card door with count chip |
| PH-17 | Overview card: Your account | DS-COMP-8 Door card | card door |
| PH-18 | Recent work head | DS-COMP-7 Card (content and list card) | card head with action |
| PH-19 | Gallery tiles ×8 | DS-COMP-39 Media tile | gallery tile variant (remapped by the Astra cross-check) |
### Weekly report (client face) › Client-face deltas (every other element: CLIENT WK-*/RC-*)

| Id | Element | Component | Note |
|---|---|---|---|
| PW-01 | Header meta | DS-COMP-3 Page header | report meta, client face |
| PW-02 | Client call to action (WK-14) | DS-COMP-8 Door card | cta strip variant (.ccta) |
| PW-03 | Verdict strip source names (WK-13) | DS-COMP-9 Verdict strip | source cite as plain text on client face |
| PW-04 | askbtn ×4 in the strip | DS-PRIM-2 Icon button (including close ×) | ask icon buttons |
| PW-05 | Mark outcome ×3 (WK-20) | DS-PRIM-1 Button | secondary small |
| PW-06 | Handoff (WK-23) | DS-COMP-8 Door card | cta strip variant (.handoff) |
### Monthly report (client face) › Client-face deltas

| Id | Element | Component | Note |
|---|---|---|---|
| PM-01 | Header meta | DS-COMP-3 Page header | report meta, client face |
| PM-02 | Client CTA (MO-04) | DS-COMP-8 Door card | cta strip variant (.ccta) |
| PM-03 | Section tip lead | DS-COMP-5 Tip and alert strips (placement) | section tip |
| PM-04 | Sortable table heads (MO-06, MO-08) | DS-PRIM-20 Table and cells | sortable column heads |
| PM-05 | Recommendation cards ×3 (MO-10) | DS-COMP-11 Recommendation card | needs decision and needsKind none |
| PM-06 | askbtn ×3 (MO-05 strip) | DS-PRIM-2 Icon button (including close ×) | ask icon buttons |
### Track record

| Id | Element | Component | Note |
|---|---|---|---|
| PT-01 | Sync marker | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker |
| PT-02 | Page tip | DS-COMP-5 Tip and alert strips (placement) | page tip |
| PT-03 | Section heads ×3 | DS-COMP-4 Section head | numbered |
| PT-04 | Verdict strip | DS-COMP-9 Verdict strip | full variant |
| PT-05 | Stat row | DS-COMP-6 Stat row | g4 |
| PT-06 | Attribution line | `content` | attribution sentence, plain copy |
| PT-07 | Said vs happened row ×3 | DS-COMP-13 List row | said vs happened page rows |
| PT-08 | Feed cards ×2 | DS-COMP-8 Door card | card door variant |
### All projects (the split-card board)

| Id | Element | Component | Note |
|---|---|---|---|
| PP-01 | Tabs | DS-COMP-2 Tab row and tab mark | tab row |
| PP-02 | Sync marker | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker |
| PP-03 | Ask us | DS-PRIM-1 Button | secondary small |
| PP-04 | Page tip | DS-COMP-5 Tip and alert strips (placement) | page tip |
| PP-05 | Stat: Active projects | DS-PRIM-24 KPI number | one KPI with of N and track |
| PP-06 | Stat: Complete | DS-PRIM-24 KPI number | one KPI, quiet track |
| PP-07 | Stat: Steps done (the mockup's Avg progress, evidence only) | DS-PRIM-24 KPI number | one KPI, "n of m steps done" (T12, C56) |
| PP-08 | Stat: Awaiting your reply | DS-PRIM-24 KPI number | one KPI with of N |
| PP-09 | Filter label + Clear all | DS-COMP-16 Filter and command bar | filter bar label and clear action |
| PP-10 | Preset chips ×5 | DS-PRIM-10 Segmented control and facet | facet chips |
| PP-11 | Show all filters | DS-PRIM-1 Button | link-look text button |
| PP-12 | Search field | DS-PRIM-6 Search box and keycap | search box |
| PP-13 | Project card, work half | DS-COMP-18 Board card | project card, client split |
| PP-14 | Review card, work half | DS-COMP-18 Board card | review card, client split |
| PP-15 | Step card, work half | DS-COMP-18 Board card | step card, client split |
| PP-16 | Approve | DS-PRIM-1 Button | primary small, disabled once approved |
| PP-17 | Request changes | DS-PRIM-1 Button | secondary small |
| PP-18 | Thread | DS-COMP-15 Message thread and composer | message thread |
| PP-19 | Edit your comment | DS-PRIM-2 Icon button (including close ×) | edit pencil, hover reveal |
| PP-20 | Composer | DS-COMP-15 Message thread and composer | composer |
### Growth roadmap

| Id | Element | Component | Note |
|---|---|---|---|
| PG-01 | Header meta | DS-COMP-3 Page header | meta slot with sync and Ask us |
| PG-02 | Tips ×2 | DS-COMP-5 Tip and alert strips (placement) | page tip and section tip |
| PG-03 | Column head ×3 | DS-COMP-20 Roadmap columns | column heads |
| PG-04 | Roadmap item ×6 | DS-COMP-20 Roadmap columns | roadmap items |
### Library ▸ Brand

| Id | Element | Component | Note |
|---|---|---|---|
| PLB-01 | Sync | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker |
| PLB-02 | Download brand kit | DS-PRIM-1 Button | secondary small |
| PLB-03 | Page tip | DS-COMP-5 Tip and alert strips (placement) | page tip |
| PLB-04 | Logo card head | DS-COMP-7 Card (content and list card) | card head with action |
| PLB-05 | Logo variant ×3 | DS-COMP-7 Card (content and list card) | logo tile card with art and buttons |
| PLB-06 | Typography | DS-COMP-7 Card (content and list card) | padded card |
| PLB-07 | Colour palette ×6 | DS-COMP-7 Card (content and list card) | padded card of swatches |
| PLB-08 | Hero photo / Hero video | DS-COMP-7 Card (content and list card) | card holding the photo and video tiles with Download; the tiles are DS-COMP-39 (built on; noted by RECONCILE-LOOK) |
### Library ▸ Voice (client face)

| Id | Element | Component | Note |
|---|---|---|---|
| PLV-01 | Sync | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker |
| PLV-02 | §001 head (client) | DS-COMP-4 Section head | numbered with count and tip |
| PLV-03 | Lever card ×4 | DS-COMP-7 Card (content and list card) | lever card; div.doc is not a door |
| PLV-04 | §002 head (client) | DS-COMP-4 Section head | numbered with count and tip |
| PLV-05 | Note row ×n | DS-COMP-15 Message thread and composer | voice note messages (.msg.vnote) |
| PLV-06 | Remove note | DS-PRIM-2 Icon button (including close ×) | remove ×, unstyled defect |
| PLV-07 | Composer | DS-COMP-26 Form layout | inline form (voiceNoteForm), client face |
| PLV-08 | About options | DS-PRIM-19 Menu and popover | house select menu options |
### Library ▸ Drive

| Id | Element | Component | Note |
|---|---|---|---|
| PLD-01 | Sync | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker |
| PLD-02 | Open in Google Drive ↗ | DS-PRIM-1 Button | secondary small |
| PLD-03 | Tile ×18 (4 starred, 6 folders, 8 files) | DS-COMP-7 Card (content and list card) | drive item tiles; not doors by ruling |
| PLD-04 | Upload | DS-PRIM-1 Button | secondary small in card head |
### Library ▸ Docs (client face)

| Id | Element | Component | Note |
|---|---|---|---|
| PLK-01 | Sync | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker |
| PLK-02 | §001 head | DS-COMP-4 Section head | numbered with tip |
| PLK-03 | Doc card with url ×2 | DS-COMP-8 Door card | card door (a.doc) |
| PLK-04 | Doc card without url ×5 | DS-COMP-7 Card (content and list card) | div.doc, no door styling |
| PLK-05 | §003 head | DS-COMP-4 Section head | numbered with tip |
| PLK-06 | Asset row ×3 | DS-COMP-8 Door card | row door (.lassetrow) |
### Account (Invoices, Ad hoc hours, Business details, Your plan, Settings), client face › Client-side elements an

| Id | Element | Component | Note |
|---|---|---|---|
| PAI-01 | all | DS-PRIM-1 Button | header button, unwired |
| PAI-02 | Invoices | DS-PRIM-1 Button | primary, unwired |
| PAI-03 | Invoices | DS-PRIM-1 Button | secondary buttons, unwired |
| PAI-04 | Invoices | DS-PRIM-20 Table and cells | sortable table |
| PAH-01 | Ad hoc | DS-PRIM-26 Link and door link | project link, wrong target |
| PAH-02 | Ad hoc | DS-PRIM-1 Button | secondary small, unwired |
| PAD-01 | Business details | DS-PRIM-1 Button | Edit details button, the one client write |
| PAD-02 | Business details | DS-PRIM-1 Button | Edit button, unwired |
| PAD-03 | Business details | DS-PRIM-26 Link and door link | mailto links |
| PAD-04 | Business details | DS-PRIM-1 Button | secondary buttons, unwired |
| PAD-05 | Business details | DS-PRIM-26 Link and door link | link inside the banner |
| PAP-01 | Your plan | DS-COMP-7 Card (content and list card) | tier cards read only, current tier marked |
| PAP-02 | Your plan | DS-PRIM-1 Button | primary, navigates to Contact |
| PAS-01 | Settings | DS-PRIM-10 Segmented control and facet | drawn segmented, per AC-18 |
| PAS-02 | Settings | DS-PRIM-10 Segmented control and facet | drawn segmented, per AC-19 |
### Account ▸ Connections (client face)

| Id | Element | Component | Note |
|---|---|---|---|
| PAC-01 | Sync | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker |
| PAC-02 | Tip | DS-COMP-5 Tip and alert strips (placement) | page tip |
| PAC-03 | Row ×5 | DS-COMP-13 List row | connection page rows, remove-only |
| PAC-04 | Remove ×3 | DS-PRIM-1 Button | secondary small |
| PAC-05 | Foot | `content` | foot copy line; its link is DS-PRIM-26 |
### Contact

| Id | Element | Component | Note |
|---|---|---|---|
| PC-01 | Sync | DS-PRIM-25 Marker, tag, stamp, index and freshness | freshness marker |
| PC-02 | Book a meeting (header) | DS-PRIM-1 Button | primary small |
| PC-03 | Tip | DS-COMP-5 Tip and alert strips (placement) | page tip |
| PC-04 | Card head | DS-COMP-7 Card (content and list card) | card head of the ticket form |
| PC-05 | Topic | DS-PRIM-5 Select | house select with label |
| PC-06 | Subject | DS-PRIM-3 Text input | text input |
| PC-07 | Message | DS-PRIM-4 Textarea | textarea |
| PC-08 | Reply promise + Open a ticket | DS-COMP-26 Form layout | form foot: promise plus primary action |
| PC-09 | Your open tickets | DS-COMP-8 Door card | row door (.chanflag) |
| PC-10 | Forms we've asked you to fill in | DS-COMP-13 List row | record rows |
| PC-11 | Your team at <agency> | DS-COMP-13 List row | people rows (peopleList) |
| PC-12 | Book a meeting card | DS-COMP-32 Meeting card | meeting card in a card |
### Book a meeting › Elements (as built)

| Id | Element | Component | Note |
|---|---|---|---|
| PB-01 | Back to contact | DS-PRIM-1 Button | secondary small |
| PB-02 | Tip | DS-COMP-5 Tip and alert strips (placement) | page tip |
| PB-03 | Type card head | DS-COMP-7 Card (content and list card) | card head |
| PB-04 | Type button ×2 | DS-PRIM-5 Select | superseded by R27: the portal opens the one booking card, whose Kind is a select (as BR-24); the meeting-type tile is retired |
| PB-05 | Time card head | DS-COMP-7 Card (content and list card) | card head |
| PB-06 | Day button ×6 | DS-PRIM-5 Select | superseded by R27: the one booking card's Day (as BR-19); the day list is retired |
| PB-07 | Slot button ×12 | DS-COMP-38 Calendar and date grid | `slot grid`, the one booking card's time slots (as BR-21; R27) |
| PB-08 | Slot note | DS-PRIM-25 Marker, tag, stamp, index and freshness | mono meta note |
| PB-09 | Summary + Confirm booking | DS-COMP-26 Form layout | form foot: summary plus disabled primary |

## Fresh-audit elements with no inventory row

Added 27 September 2026 by lane RECONCILE-LOOK (#325), reconciling the fresh capability-first audit (`evidence/fresh-audit/`, ids `FA-<AREA>-<n>`) with this map. Each row below is an element the fresh audit found that no inventory row names: a shell state, a behaviour with a drawn result, a door into a panel, a placeholder address or an absent element. It points to one canonical component, or to `content` (behaviour, copy or an absent element, with the reason). Every other fresh row matched an inventory row above; the full table is `evidence/RECONCILE-LOOK.md`. These rows are not counted in the coverage figures or the reverse index, which describe the inventory rows.


### SHELL.md (fresh audit)

| Id | Element | Component | Note |
|---|---|---|---|
| FA-SHELL-1 | `.shell` grid | DS-SIDE-11 Navigation rail | shared shell geometry |
| FA-SHELL-2 | Pre-paint boot hook | DS-SIDE-11 Navigation rail | persistence; behaviour; no look |
| FA-SHELL-3 | Chrome height publisher | `content` | TOKENS shell dimensions (`--chrome-h`); behaviour; no look |
| FA-SHELL-4 | Face and theme crossfade | DS-SIDE-11 Navigation rail | theme or face shift motion |
| FA-SHELL-13 | Portal items | DS-SIDE-13 Rail item | client face set |
| FA-SHELL-14 | "HUB" label on the client face | DS-SIDE-12 Rail brand |  |
| FA-SHELL-30 | Signed-in person | `content` | absent in the mockup; gap: nothing drawn; a personal menu would be built on DS-PRIM-16 and DS-PRIM-19 (capability: `PLACEHOLDERS.md` row `FA-SHELL-30`, SHELL flag 3 settled) |
| FA-SHELL-42 | Arrival flash and hash settle | DS-PRIM-33 Locate flash |  |
| FA-SHELL-43 | Face copy and channel-link gating | DS-COMP-35 Client face deltas | face copy is content; the face deltas table is its home |
| FA-SHELL-48 | Bare `/route-home/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |

### DOCK.md (fresh audit)

| Id | Element | Component | Note |
|---|---|---|---|
| FA-DOCK-10 | Panel shell `.dpanel` | DS-SIDE-7 Dock panel |  |
| FA-DOCK-18 | Seated form (from 1440) | DS-SIDE-7 Dock panel |  |
| FA-DOCK-19 | Floating form | DS-SIDE-7 Dock panel |  |
| FA-DOCK-20 | Open and close motion | DS-SIDE-7 Dock panel |  |
| FA-DOCK-21 | Empty panels | DS-PRIM-28 Empty state |  |
| FA-DOCK-22 | One gesture law for programmatic opens | DS-SIDE-7 Dock panel |  |
| FA-DOCK-24 | What stays open across pages | DS-SIDE-7 Dock panel |  |
| FA-DOCK-25 | Pre-paint replay | DS-SIDE-7 Dock panel |  |
| FA-DOCK-26 | Global history entries | DS-SIDE-9 Panel head button (close, back, forward) |  |
| FA-DOCK-28 | Seams at module scope | DS-SIDE-7 Dock panel |  |
| FA-DOCK-29 | Dead or stale mechanism | DS-SIDE-7 Dock panel |  |
| FA-DOCK-33 | Stacked sheet | DS-SIDE-7 Dock panel |  |
| FA-DOCK-34 | Phone strip | DS-SIDE-6 Sheet tab strip |  |
| FA-DOCK-35 | Phone tab order | DS-SIDE-6 Sheet tab strip |  |
| FA-DOCK-36 | Overflow at 390 | DS-SIDE-6 Sheet tab strip |  |
| FA-DOCK-37 | Divider on the phone strip | DS-SIDE-6 Sheet tab strip |  |
| FA-DOCK-38 | Phone sheet | DS-SIDE-7 Dock panel |  |
| FA-DOCK-53 | Ask from any widget (`[data-ask]` sparkle) | DS-PRIM-2 Icon button (including close ×) |  |
| FA-DOCK-54 | "Read everything" (`aaIngestAll`) | DS-PRIM-1 Button |  |
| FA-DOCK-55 | Hidden `#aiToggle` | `content` | behaviour or absent; no look |
| FA-DOCK-56 | Conversation persistence | DS-COMP-23 Panel tab set |  |
| FA-DOCK-57 | Context bundle (no control) | `content` | behaviour or absent; no look |
| FA-DOCK-69 | No dismiss, clear or mark-all-read | `content` | behaviour or absent; no look |
| FA-DOCK-70 | Live refresh | `content` | behaviour or absent; no look |
| FA-DOCK-71 | Whose bell | `content` | behaviour or absent; no look |
| FA-DOCK-72 | Team tab and count | DS-SIDE-4 Dock count chip |  |
| FA-DOCK-88 | Shift-click a row | DS-SIDE-7 Dock panel |  |
| FA-DOCK-107 | Second click on the same client from the CRM board | DS-SIDE-7 Dock panel |  |
| FA-DOCK-117 | Lens seams (for a client, their comments, a family, a person) | `content` | behaviour or absent; no look |
| FA-DOCK-123 | Reorder | `content` | behaviour or absent; no look |
| FA-DOCK-138 | Widget ask sparkle `button.askbtn[data-ask]` (16 sites in `ui.js`; brief, site health) | DS-PRIM-2 Icon button (including close ×) |  |
| FA-DOCK-139 | Ask box and suggestions (`[data-ask-go]`, `.askbox__s`) | DS-COMP-26 Form layout | the ask box is an input plus suggestion chips (DS-PRIM-3, DS-PRIM-11) in a form block |
| FA-DOCK-140 | Recommendation and alert CTA `button[data-ask]` | DS-PRIM-1 Button |  |
| FA-DOCK-141 | Brief "Read everything and start a fresh chat" | DS-PRIM-1 Button |  |
| FA-DOCK-142 | Widget corner task icon `[data-task]` (5 sites) | DS-PRIM-2 Icon button (including close ×) |  |
| FA-DOCK-143 | Projects board row, review card, "View plan" | DS-COMP-17 Board table |  |
| FA-DOCK-144 | Projects board client chip `.rq__cl[data-client]` | DS-PRIM-11 Chip and pill |  |
| FA-DOCK-145 | Skill and clearance chips `[data-doc]` (Projects board, task page, anywhere) | DS-PRIM-11 Chip and pill |  |
| FA-DOCK-146 | Work log rows `.act__row[data-proj]` (agency projects) | DS-COMP-14 Feed and ledger |  |
| FA-DOCK-147 | Calendar lines `[data-cal-proj]` | DS-COMP-38 Calendar and date grid |  |
| FA-DOCK-148 | Brief timeline bars `button[data-proj]` | DS-COMP-30 Project timeline (Gantt) |  |
| FA-DOCK-149 | CRM board row `[data-client]` | DS-COMP-17 Board table |  |
| FA-DOCK-150 | CRM board capacity squares, Projects and Docs routes | DS-COMP-19 Stage strip |  |
| FA-DOCK-151 | Review board "task" action `[data-act=task]` | DS-COMP-18 Board card |  |
| FA-DOCK-152 | Keyboard opens (Enter or Space on boards) | `content` | behaviour or absent; no look; keyboard behaviour |
| FA-DOCK-153 | Dock on the client face, and the portal "Ask us" | `content` | behaviour or absent; no look; nothing drawn on the client face |

### TASKS.md (fresh audit)

| Id | Element | Component | Note |
|---|---|---|---|
| FA-TASKS-1 | Panel frame (width, seat, float, sheet) | DS-SIDE-7 Dock panel |  |
| FA-TASKS-2 | Resize grip (panel edge) | DS-SIDE-10 Panel width grip |  |
| FA-TASKS-8 | Divider | DS-SIDE-8 Panel head |  |
| FA-TASKS-14 | Team pane layout (dock) | DS-SIDE-7 Dock panel |  |
| FA-TASKS-15 | Agent pane layout (dock) | DS-SIDE-7 Dock panel |  |
| FA-TASKS-16 | Empty panel (opened from the rail with nothing open) | DS-PRIM-28 Empty state |  |
| FA-TASKS-17 | Stale or missing stored task | DS-PRIM-30 Error state |  |
| FA-TASKS-18 | Loading state | DS-PRIM-29 Loading state (gap, proposed) | DS-PRIM-29 is the proposed loading pattern (DR-37) |
| FA-TASKS-19 | The open task rides along between pages | DS-SIDE-7 Dock panel |  |
| FA-TASKS-20 | Who else is viewing (presence) | `content` | behaviour or absent; no look |
| FA-TASKS-22 | Page pane switching and the Agent two-column layout | DS-COMP-37 Report layouts |  |
| FA-TASKS-24 | Entry points: dock head "+", board "New task", corner task icons, empty Task tab | DS-PRIM-2 Icon button (including close ×) |  |
| FA-TASKS-27 | Draft fields and their defaults (Assignee, Client, Due date, Estimate, Project, Categor… | DS-PRIM-5 Select |  |
| FA-TASKS-31 | Create task route button | DS-PRIM-1 Button |  |
| FA-TASKS-32 | Drawer form (name, description, assignee, due, category, estimate, priority) | DS-COMP-26 Form layout |  |
| FA-TASKS-33 | Drawer Create task and Cancel, and the receipt stamp | DS-PRIM-1 Button |  |
| FA-TASKS-34 | Projects board row (name cell, play, plus) | DS-COMP-17 Board table |  |
| FA-TASKS-36 | Notification row, review board item, activity log row, calendar item | DS-COMP-13 List row |  |
| FA-TASKS-37 | Brief timeline bar (gantt) | DS-COMP-30 Project timeline (Gantt) |  |
| FA-TASKS-38 | Client-portal projects row, agency face (the hash address) | DS-COMP-17 Board table |  |
| FA-TASKS-40 | Page layout by width | DS-COMP-37 Report layouts |  |
| FA-TASKS-47 | Back door and address upkeep (appbar Back and Forward, popstate, canonical rewrite) | `content` | behaviour or absent; no look; behaviour |
| FA-TASKS-48 | Client face on the task page | `content` | behaviour or absent; no look; behaviour (gating) |
| FA-TASKS-56 | Waiting on client for an internal approval | DS-PRIM-15 Status mark (text and chip) |  |
| FA-TASKS-57 | Completion (Complete, reopen) | DS-PRIM-1 Button |  |
| FA-TASKS-77 | Pan and zoom (`.tg__scroll`) | DS-TASK-12 Execution graph |  |
| FA-TASKS-81 | Receipt after a decision (absent) | `content` | behaviour or absent; no look; absent; no look to map |
| FA-TASKS-82 | Checks (evidence) and "Checks passed" | DS-TASK-6 Output and evidence box |  |
| FA-TASKS-92 | Run history rows (`.tokrun`) and switching between runs | DS-TASK-9 Token tracked |  |
| FA-TASKS-93 | Start, rerun and stop controls (absent) | `content` | behaviour or absent; no look; absent; no look to map |
| FA-TASKS-94 | Run states vocabulary | DS-PRIM-15 Status mark (text and chip) |  |
| FA-TASKS-96 | Agent tab badge (`.cmtab[data-task-tab="agent"] .cbadge`) | DS-PRIM-13 Count |  |

### BOARDS.md (fresh audit)

| Id | Element | Component | Note |
|---|---|---|---|
| FA-BOARDS-15 | Tab row under the app bar | DS-COMP-2 Tab row and tab mark |  |
| FA-BOARDS-17 | Keyboard on rows | DS-COMP-17 Board table |  |
| FA-BOARDS-18 | Per-tab state | `content` | behaviour or absent; no look; behaviour (per-tab state) |
| FA-BOARDS-19 | Counts that absent themselves | DS-PRIM-13 Count |  |
| FA-BOARDS-41 | Topbar bar on the other panels | DS-COMP-16 Filter and command bar |  |
| FA-BOARDS-56 | Placeholder page | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
| FA-BOARDS-75 | Placeholder page | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |

### AGENCY.md (fresh audit)

| Id | Element | Component | Note |
|---|---|---|---|
| FA-AGENCY-22 | "CPQL" glossary term | DS-PRIM-18 Tooltip and callout |  |
| FA-AGENCY-73 | AI card | DS-COMP-10 Finding card |  |
| FA-AGENCY-85 | Docs `/docs/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
| FA-AGENCY-86 | Snippets `/docs/snippets/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
| FA-AGENCY-87 | Settings ▸ General `/settings/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
| FA-AGENCY-88 | Settings ▸ Keys `/settings/keys/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
| FA-AGENCY-89 | Settings ▸ Access `/settings/access/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
| FA-AGENCY-90 | Settings ▸ Emails `/settings/emails/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
| FA-AGENCY-91 | Settings ▸ Workflow triggers `/settings/workflow-triggers/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
| FA-AGENCY-92 | Settings ▸ Telemetry `/settings/telemetry/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
| FA-AGENCY-93 | Settings ▸ Cal `/settings/cal/` | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |

### CLIENT.md (fresh audit)

| Id | Element | Component | Note |
|---|---|---|---|
| FA-CLIENT-12 | Source links ("CRM", "GA4", "GOOGLE ADS" chips on a row) | DS-PRIM-26 Link and door link | the `a.chlink` source link, DS-PRIM-26 (AG-K6 is the same look) |
| FA-CLIENT-13 | "MOCK" tag on a figure (for example Return on ad spend, Revenue from marketing) | DS-PRIM-32 Mock-data mark | the mock mark, DS-PRIM-32 |
| FA-CLIENT-31 | Brief at 390 | DS-COMP-37 Report layouts |  |
| FA-CLIENT-98 | Agent draft row ("DRAFT" chip, "Rewrite the emergency page hero …", assignee "AI", "18k… | DS-PRIM-11 Chip and pill |  |
| FA-CLIENT-99 | Client face of the same address: the four-stat summary, the review filter row, and spli… | DS-COMP-18 Board card |  |
| FA-CLIENT-57 | Brand assets: upload or replace (not drawn) | `content` | behaviour or absent; no look; not drawn (upload or replace) |
| FA-CLIENT-67 | "Upload" | DS-PRIM-1 Button |  |

### WORKBENCH.md (fresh audit)

| Id | Element | Component | Note |
|---|---|---|---|
| FA-WORKBENCH-8 | Channel availability | `content` | behaviour or absent; no look; not a control |
| FA-WORKBENCH-9 | Address of an absent channel | DS-PRIM-28 Empty state | the one "Not connected: <dependency>" state with its Connections link (MP-1-6 treatment); was DS-PRIM-20 |
| FA-WORKBENCH-10 | Retired hash aliases | `content` | behaviour or absent; no look; behaviour |
| FA-WORKBENCH-11 | Default tab | `content` | behaviour or absent; no look; behaviour |
| FA-WORKBENCH-12 | Tab order | DS-COMP-2 Tab row and tab mark |  |
| FA-WORKBENCH-13 | Per-tab client exposure | `content` | behaviour or absent; no look; none drawn |
| FA-WORKBENCH-22 | Task drawer | DS-COMP-26 Form layout |  |
| FA-WORKBENCH-31 | AI hint row with action ("See the maths") | DS-PRIM-22 Banner and tip |  |

### PORTAL.md (fresh audit)

| Id | Element | Component | Note |
|---|---|---|---|
| FA-PORTAL-1 | Rail, client group (Home, Reports, Projects, Library, Account, Contact) | DS-SIDE-11 Navigation rail |  |
| FA-PORTAL-2 | Agency-only markup in the client DOM | `content` | behaviour or absent; no look; agency-only markup; nothing drawn |
| FA-PORTAL-3 | Rail collapse "«" | DS-SIDE-15 Rail fold button |  |
| FA-PORTAL-4 | App strip | DS-COMP-1 App strip |  |
| FA-PORTAL-5 | Back and Forward | DS-COMP-1 App strip |  |
| FA-PORTAL-6 | Client identity (the client's mark and name, "CLIENT PORTAL"; the mockup's sample reads "M", "Meridian Dental") | DS-COMP-1 App strip |  |
| FA-PORTAL-7 | Search "Search… ⌘K" | DS-COMP-1 App strip |  |
| FA-PORTAL-8 | Face switch "AGENCY / CLIENT" | DS-COMP-1 App strip |  |
| FA-PORTAL-9 | Start timer | DS-COMP-1 App strip |  |
| FA-PORTAL-10 | Presence circles | DS-COMP-1 App strip |  |
| FA-PORTAL-15 | Mobile navigation (at 900 and below) | DS-SIDE-17 Navigation toggle (hamburger) |  |
| FA-PORTAL-16 | Arrival flash on deep links | DS-PRIM-33 Locate flash |  |
| FA-PORTAL-28 | Report tabs (Weekly, Monthly, Track record) | DS-COMP-2 Tab row and tab mark |  |
| FA-PORTAL-29 | "Week ending Sun 19 Jul ▾" | DS-PRIM-1 Button |  |
| FA-PORTAL-30 | "Download PDF" | DS-PRIM-1 Button |  |
| FA-PORTAL-31 | "FROZEN SUNDAY" chip | DS-PRIM-11 Chip and pill |  |
| FA-PORTAL-32 | Verdict hero and pace meter | DS-COMP-31 Hero |  |
| FA-PORTAL-35 | "Where these numbers come from" disclosure | DS-COMP-12 Disclosure layer |  |
| FA-PORTAL-36 | Recommendation card, "Good to go" | DS-COMP-11 Recommendation card |  |
| FA-PORTAL-37 | "Let's discuss" and its panel | DS-COMP-11 Recommendation card |  |
| FA-PORTAL-38 | Silence on an open recommendation | `content` | behaviour or absent; no look; behaviour |
| FA-PORTAL-40 | "See all 128" | DS-PRIM-1 Button |  |
| FA-PORTAL-41 | Source bars | DS-COMP-29 Inline chart (sparkline, bar list, band track) |  |
| FA-PORTAL-44 | "Download PDF" | DS-PRIM-1 Button |  |
| FA-PORTAL-50 | Track record extract and "Full track record →" | DS-COMP-13 List row |  |
| FA-PORTAL-51 | Caveats and "What happens next" | DS-COMP-37 Report layouts |  |
| FA-PORTAL-68 | Summary tiles and "Ask us" | DS-PRIM-24 KPI number |  |
| FA-PORTAL-71 | Reviews state of the board | DS-COMP-18 Board card |  |
| FA-PORTAL-72 | "Approved" card still offering "Request changes" | DS-PRIM-1 Button |  |
| FA-PORTAL-81 | "Where these come from" forms directory | `content` | behaviour or absent; no look; agency face only |
| FA-PORTAL-87 | "Page copy & compliance" (internal) | `content` | behaviour or absent; no look; agency face only |
| FA-PORTAL-89 | "BILLING SYNCED 1 JUL" stamp | DS-PRIM-25 Marker, tag, stamp, index and freshness |  |
| FA-PORTAL-91 | KPI row (Paid to date, Outstanding, Yet to be invoiced, Last invoice) | DS-COMP-6 Stat row |  |
| FA-PORTAL-92 | "Where your account stands" bar | DS-COMP-29 Inline chart (sparkline, bar list, band track) |  |
| FA-PORTAL-95 | KPI row | DS-COMP-6 Stat row |  |
| FA-PORTAL-98 | Rates card | DS-COMP-7 Card (content and list card) |  |
| FA-PORTAL-102 | Service plan card | DS-COMP-7 Card (content and list card) |  |
| FA-PORTAL-103 | Service agreement: "Signed" chip, "View", "Download PDF" | DS-PRIM-15 Status mark (text and chip) |  |
| FA-PORTAL-104 | "Need to reach us…" banner with Contact link | DS-PRIM-22 Banner and tip |  |
| FA-PORTAL-109 | Add path and catalogue | `content` | behaviour or absent; no look; agency face only |
| FA-PORTAL-113 | "Reset" dismissed tips | DS-PRIM-1 Button |  |
| FA-PORTAL-114 | Email notifications (not drawn) | DS-PRIM-9 Switch | not drawn; the register builds it on the Switch (OP-24) |
| FA-PORTAL-130 | "Review has moved" stub | DS-PRIM-28 Empty state | undesigned address: the one empty state until its page is designed (R2 (a)); was DS-COMP-36, retired |
| FA-PORTAL-131 | Entering the portal from the internal workspace | DS-COMP-1 App strip |  |
| FA-PORTAL-132 | Writes while previewing | `content` | behaviour or absent; no look; behaviour |
| FA-PORTAL-133 | Agency copy variants ("<Client>'s portal home.", "Where <Client>'s account stands"; the mockup's sample reads "Meridian's") | DS-COMP-35 Client face deltas | client face copy: DS-COMP-35 |

**Tally of these rows by target:** content 28, DS-SIDE-7 17, DS-PRIM-28 16, DS-PRIM-1 13, DS-COMP-1 8, DS-COMP-17 5, DS-COMP-37 4, DS-PRIM-11 4, DS-PRIM-2 4, DS-SIDE-11 4, DS-SIDE-6 4, DS-COMP-18 3, DS-COMP-2 3, DS-COMP-26 3, DS-PRIM-15 3, DS-COMP-11 2, DS-COMP-13 2, DS-COMP-29 2, DS-COMP-30 2, DS-COMP-35 2, DS-COMP-6 2, DS-COMP-7 2, DS-PRIM-13 2, DS-PRIM-22 2, DS-PRIM-33 2, DS-COMP-10 1, DS-COMP-12 1, DS-COMP-14 1, DS-COMP-16 1, DS-COMP-19 1, DS-COMP-23 1, DS-COMP-31 1, DS-COMP-38 1, DS-PRIM-18 1, DS-PRIM-24 1, DS-PRIM-25 1, DS-PRIM-26 1, DS-PRIM-29 1, DS-PRIM-30 1, DS-PRIM-32 1, DS-PRIM-5 1, DS-PRIM-9 1, DS-SIDE-10 1, DS-SIDE-12 1, DS-SIDE-13 1, DS-SIDE-15 1, DS-SIDE-17 1, DS-SIDE-4 1, DS-SIDE-8 1, DS-SIDE-9 1, DS-TASK-12 1, DS-TASK-6 1, DS-TASK-9 1 (167 rows; recounted by AUDIT-RECONCILE, 27 September).


## Reverse index: where each component is used

Every element row that targets each component, by inventory file. An element built from a component's parts (a count inside a tab, a switch inside a row) is listed under the outer component only.

| Component | Rows | Element ids |
|---|---|---|
| DS-SIDE-1 Dock edge rail | 3 | DOCK: DK-01, DK-04; SHELL: SH-25 |
| DS-SIDE-2 Dock tab | 1 | DOCK: DK-02 |
| DS-SIDE-3 Dock tab callout | 1 | DOCK: DK-03 |
| DS-SIDE-4 Dock count chip | 3 | DOCK: DK-05, NT-01; SHELL: SH-26 |
| DS-SIDE-5 Close all | 1 | DOCK: DK-06 |
| DS-SIDE-6 Sheet tab strip | 1 | DOCK: DK-07 |
| DS-SIDE-7 Dock panel | 1 | TASKS: DN-05 |
| DS-SIDE-8 Panel head | 10 | DOCK: DK-08, DK-09, DK-10, CL-01, CL-02, CL-03, PJ-01, AI-01, AI-03; TASKS: DP-01 |
| DS-SIDE-9 Panel head button (close, back, forward) | 8 | DOCK: DK-11, DK-12, DK-13, CL-04, AI-04, AI-05; TASKS: DP-06, DP-07 |
| DS-SIDE-10 Panel width grip | 2 | DOCK: DK-14; SHELL: SH-8 |
| DS-SIDE-11 Navigation rail | 2 | SHELL: SH-1, SH-9 |
| DS-SIDE-12 Rail brand | 2 | SHELL: SH-2, SH-3 |
| DS-SIDE-13 Rail item | 2 | SHELL: SH-4, SH-5 |
| DS-SIDE-14 Railmark | 1 | SHELL: SH-6 |
| DS-SIDE-15 Rail fold button | 1 | SHELL: SH-7 |
| DS-SIDE-17 Navigation toggle (hamburger) | 1 | SHELL: SH-23 |
| DS-SIDE-18 Drawer backdrop | 1 | SHELL: SH-24 |
| DS-SIDE-19 Client workspace group | 2 | SHELL: SH-30, SH-31 |
| DS-PRIM-1 Button | 156 | AGENCY: AG-P4, AG-P25, AG-C3, AG-C7, AG-C18, AG-C19, AG-S3; BOARDS: B-08, P-05, P-06, P-08, P-49, P-60, R-07, R-08, R-09, L-02, C-02, C-07, C-33, C-44, M-06, V-03; CLIENT: BR-02, BR-09, BR-15, BR-16, BR-47, RC-10, RC-11, WK-01, WK-02, WK-03, WK-21, BD-01, DR-01, AC-05, AC-09; DOCK: CR-11, CR-22, CR-24, CR-26, DC-03, DC-07, DC-11, BM-01, BM-08, AI-12; PORTAL: PH-12, PW-05, PP-03, PP-11, PP-16, PP-17, PLB-02, PLD-02, PLD-04, PAI-01, PAI-02, PAI-03, PAH-02, PAD-01, PAD-02, PAD-04, PAP-02, PAC-04, PC-02, PB-01; TASKS: DP-20c, DP-30, DT-06, DT-10, DT-13, DN-03, DN-04, TT-06; WORKBENCH: WSH-04, WSH-05, CN-W07, CN-M03, CN-M05, CN-M06, CNX-M03, CNX-M05, CNX-M06, CNX-M07, CNX-M08, CNX-M10, CNX-M11, TL-M05, TL-M06, TL-M07, TL-M08, OB-M03, OB-M04, OB-M05, FM-M05, FM-M06, FM-M07, FM-M08, SS-M05, SS-M06, SS-M07, SS3-M05, SS3-M06, SS3-M07, SI-M05, SI-M06, SI-M07, SI-M08, SI-M10, SI-M15, SIR-M05, SIR-M06, SIR-M07, SIR-M08, SIR-M10, SIR-M16, GA-M03, GA-M04, GA-M05, GA-M11, MA-M03, MA-M04, MA-M05, MA-M08, TS-M02, TS-M03, TS-M04, LR-M05, LR-M06, LR-M07, CL-M05, CL-M06, CL-M07, CL-M08, CL-M10, EM-M05, EM-M06, EM-M07, EM-M08, EM-M12, FN-M05, FN-M06, FN-M07, RV-M05, RV-M06, RV-M07, WP-M05, WP-M06, WP-M07, WP-M08, WPO-M05, WPO-M06, WPO-M07, WPO-M08 |
| DS-PRIM-2 Icon button (including close ×) | 91 | AGENCY: AG-K7, AG-K8; BOARDS: B-04, B-12, B-13, P-03, P-04, P-36, R-11, V-05; CLIENT: BR-10, BR-35, BR-36, DSY-12, VO-05; DOCK: CL-08, CL-09, CL-10, CL-11, CR-04, DC-08, BM-03, BM-04; PORTAL: PH-14, PW-04, PM-06, PP-19, PLV-06; SHELL: SH-27; TASKS: DP-02, DP-03, DP-04, DP-05, DP-09, DP-10, DP-20a, DT-17, TP-05; WORKBENCH: WSH-13, WSH-14, CN-M01, CN-M02, CNX-M01, CNX-M02, TL-M01, TL-M03, TL-M04, OB-M01, OB-M06, FM-M01, FM-M03, FM-M04, SS-M01, SS-M03, SS-M04, SS3-M01, SS3-M03, SS3-M04, SI-M01, SI-M03, SI-M04, SIR-M01, SIR-M03, SIR-M04, GA-M01, GA-M06, MA-M01, MA-M06, TS-M01, TS-M05, LR-M01, LR-M03, LR-M04, CL-M01, CL-M03, CL-M04, EM-M01, EM-M03, EM-M04, FN-M01, FN-M03, FN-M04, RV-M01, RV-M03, RV-M04, WP-M01, WP-M03, WP-M04, WPO-M01, WPO-M03, WPO-M04 |
| DS-PRIM-3 Text input | 11 | CLIENT: BR-18; DOCK: CR-27, BM-05, BM-06, AI-11; PORTAL: PC-06; TASKS: DP-08, DT-02, DN-01; WORKBENCH: SI-M12, SIR-M13 |
| DS-PRIM-4 Textarea | 7 | CLIENT: BR-25, DSY-08; DOCK: DC-01; PORTAL: PC-07; TASKS: DP-34, DP-35; WORKBENCH: CNX-M09 |
| DS-PRIM-5 Select | 29 | AGENCY: AG-K17; BOARDS: P-37, P-65; CLIENT: BR-19, BR-20, BR-22, BR-23, BR-24; DOCK: DC-09, DC-10, AI-02; PORTAL: PC-05, PB-04, PB-06; TASKS: DP-18, DP-19, DP-20, DP-20d, DP-21, DP-22, DP-23, DP-24, DP-25; WORKBENCH: SI-M11, SI-M13, SI-M14, SIR-M12, SIR-M14, SIR-M15 |
| DS-PRIM-6 Search box and keycap | 5 | BOARDS: B-01, P-02, L-01, C-01; PORTAL: PP-12 |
| DS-PRIM-7 Checkbox | 2 | BOARDS: P-30; DOCK: PJ-06 |
| DS-PRIM-10 Segmented control and facet | 26 | AGENCY: AG-K14, AG-P3, AG-P22, AG-E3, AG-X22, AG-X23; BOARDS: B-06, B-07, B-09, P-10, P-11, P-13, P-62, C-03, C-04, C-05, M-02, M-04; CLIENT: AC-18, AC-19; DOCK: CR-20, CR-21; PORTAL: PP-10, PAS-01, PAS-02; TASKS: TG-02 |
| DS-PRIM-11 Chip and pill | 24 | AGENCY: AG-K16, AG-P24j, AG-C17, AG-A3; BOARDS: B-10, B-11, P-14, P-31, P-43, P-44, P-45, P-50, M-01; CLIENT: BR-46, WK-06; DOCK: CR-05, CR-06, PJ-03, NT-07, AI-10; SHELL: SH-21; TASKS: DP-28, DA-08, TP-11 |
| DS-PRIM-13 Count | 2 | DOCK: PJ-09, TM-03 |
| DS-PRIM-14 Dot and status line | 1 | AGENCY: AG-K19 |
| DS-PRIM-15 Status mark (text and chip) | 14 | AGENCY: AG-K18, AG-P26, AG-C20, AG-S13; BOARDS: P-46, R-05; CLIENT: BR-03, RC-08, WK-09; DOCK: PJ-10, PJ-11; TASKS: DT-19, TP-04; WORKBENCH: CN-W02 |
| DS-PRIM-16 Avatar and avatar stack | 5 | BOARDS: P-42, C-20; DOCK: CR-01, PJ-07, TM-01 |
| DS-PRIM-17 Icon and door mark | 1 | BOARDS: C-22 |
| DS-PRIM-18 Tooltip and callout | 9 | WORKBENCH: FM-M10, FM-M11, FM-M12, FM-M13, GA-M08, GA-M09, GA-M10, EM-M10, EM-M11 |
| DS-PRIM-19 Menu and popover | 5 | BOARDS: B-03, B-05; CLIENT: BR-17; PORTAL: PLV-08; TASKS: DP-27 |
| DS-PRIM-20 Table and cells | 84 | AGENCY: AG-K12, AG-P24, AG-P24a, AG-P24c, AG-P24d, AG-P24e, AG-P24f, AG-P24g, AG-P24h, AG-P24k, AG-E22, AG-E25, AG-E31, AG-C14, AG-C15, AG-C16, AG-S12; BOARDS: B-19; CLIENT: MO-06, MO-08, AC-04, AC-07; PORTAL: PM-04, PAI-04; WORKBENCH: WSH-20, CN-W03, CN-W08, CN-W10, CN-M07, CN-M08, CN-M09, CN-M10, CN-M11, CN-M12, CN-M13, CN-M14, CN-M15, CN-M16, CN-M17, CN-M18, CN-M19, CN-M20, CN-M21, CNX-M12, CNX-M13, CNX-M14, CNX-M15, CNX-M16, CNX-M17, CNX-M18, CNX-M19, CNX-M20, CNX-M21, CNX-M22, CNX-M23, CNX-M24, CNX-M25, CNX-M26, TL-W04, TL-M10, OB-W04, OB-M09, FM-W03, FM-W06, FM-W09, FM-M14, SS-W06, SS-W08, SS-M11, SS3-M11, SI-W09, SI-M18, SIR-M19, GA-W05, LR-W06, LR-M09, CL-W03, CL-M11, EM-W04, EM-M13, FN-W04, FN-M10, RV-W04, RV-M09 |
| DS-PRIM-22 Banner and tip | 19 | AGENCY: AG-K2, AG-K13, AG-P5, AG-E4, AG-E26, AG-C4, AG-C6, AG-C23, AG-S4, AG-S5; BOARDS: G-01, G-02; CLIENT: DSY-06; SHELL: SH-41, SH-57; WORKBENCH: WSH-06, CN-W01, SS-W07, MA-W04 |
| DS-PRIM-23 Meter and progress | 9 | AGENCY: AG-K11; CLIENT: WK-11; TASKS: DT-09, TT-03; WORKBENCH: WSH-22, CN-W05, FM-W04, SI-W06, RV-W03 |
| DS-PRIM-24 KPI number | 5 | AGENCY: AG-K9; PORTAL: PP-05, PP-06, PP-07, PP-08 |
| DS-PRIM-25 Marker, tag, stamp, index and freshness | 45 | AGENCY: AG-K1, AG-P2, AG-P23, AG-P24i, AG-E2, AG-C2, AG-C13, AG-S2, AG-A2; BOARDS: P-07, P-47, R-03, M-07; CLIENT: BR-04, BR-05, BR-06, BR-34, BR-40, BR-48, WK-08, TR-01, DSY-01; DOCK: DC-02, DC-06, DC-17, DC-21, BM-07; PORTAL: PH-01, PT-01, PP-02, PLB-01, PLV-01, PLD-01, PLK-01, PAC-01, PC-01, PB-08; SHELL: SH-22, SH-51; TASKS: DP-32, TP-03, TG-01, TG-04; WORKBENCH: WSH-03, CN-W04 |
| DS-PRIM-26 Link and door link | 41 | AGENCY: AG-K6; BOARDS: L-07; CLIENT: BR-42, DSY-07; DOCK: CR-29, DC-05, TM-02; PORTAL: PAH-01, PAD-03, PAD-05; TASKS: DP-29, TP-01, TKM-04; WORKBENCH: WSH-24, CN-M04, CNX-M04, TL-M02, OB-M02, FM-M02, SS-M02, SS-M10, SS3-M02, SS3-M10, SI-M02, SI-M16, SI-M17, SIR-M02, SIR-M11, SIR-M17, SIR-M18, GA-M02, MA-M02, LR-M02, CL-M02, EM-M02, FN-M02, RV-M02, WP-M02, WP-M10, WPO-M02, WPO-M10 |
| DS-PRIM-27 Divider and rule | 2 | BOARDS: B-14, P-12 |
| DS-PRIM-28 Empty state | 30 | AGENCY: AG-A5, AG-A11; BOARDS: B-23, P-51, P-67, L-08; CLIENT: DOC-01, DOC-02, DOC-03, DOC-04, FM-01, FM-02, FM-03, FM-04 (undesigned addresses, R2 (a)); DOCK: CL-12, CR-30, CR-31, DC-12, DC-19, BM-09, PJ-12, TM-06, NT-09, NT-10; TASKS: DP-33, DT-07, TA-07, TG-08, TG-09, TKM-03 |
| DS-PRIM-30 Error state | 1 | TASKS: TKM-02 |
| DS-PRIM-31 Disclosure chevron | 1 | CLIENT: BR-11 |
| DS-PRIM-32 Mock-data mark | 1 | WORKBENCH: WSH-26 |
| DS-COMP-1 App strip | 9 | SHELL: SH-10, SH-11, SH-12, SH-13, SH-14, SH-15, SH-16, SH-17, SH-33 |
| DS-COMP-2 Tab row and tab mark | 5 | PORTAL: PP-01; SHELL: SH-18, SH-19, SH-32; WORKBENCH: WSH-01 |
| DS-COMP-3 Page header | 18 | AGENCY: AG-P1, AG-E1, AG-C1, AG-S1, AG-A1; BOARDS: P-01, C-08; CLIENT: WK-04, WK-05, MO-01, MO-14; PORTAL: PW-01, PM-01, PG-01; SHELL: SH-20, SH-40; TASKS: TKM-01; WORKBENCH: WSH-02 |
| DS-COMP-4 Section head | 50 | AGENCY: AG-K3, AG-P6, AG-P10, AG-P15, AG-P21, AG-E5, AG-E10, AG-E13, AG-E19, AG-E21, AG-E24, AG-E29, AG-C5, AG-C11, AG-C21, AG-C26, AG-C30, AG-C32, AG-C37, AG-C40, AG-C44, AG-C49, AG-C55, AG-C59, AG-S6, AG-S9, AG-S14, AG-S16, AG-S18, AG-S21; BOARDS: P-61; CLIENT: BR-27, BR-32, BR-49, BR-54, WK-16, WK-18, TR-03, DSY-02, DSY-10, VO-01, VO-03, VO-07; PORTAL: PT-03, PLV-02, PLV-04, PLK-02, PLK-05; SHELL: SH-42, SH-54 |
| DS-COMP-5 Tip and alert strips (placement) | 18 | CLIENT: BR-07, BR-08, BR-28, BR-39, WK-07, WK-19, MO-02, TR-02, AC-15; PORTAL: PH-02, PM-03, PT-02, PP-04, PG-02, PLB-03, PAC-02, PC-03, PB-02 |
| DS-COMP-6 Stat row | 21 | AGENCY: AG-P8, AG-E9, AG-E30, AG-C9, AG-S10; CLIENT: BR-37, TR-05, AC-01, AC-06; PORTAL: PT-05; WORKBENCH: WSH-19, TL-W03, OB-W03, FM-W02, SI-W05, GA-W03, MA-W01, LR-W02, CL-W02, EM-W03, RV-W02 |
| DS-COMP-7 Card (content and list card) | 73 | AGENCY: AG-P12, AG-P16, AG-P18, AG-P19, AG-E7, AG-E27, AG-E28, AG-E32, AG-E33, AG-C22, AG-C25, AG-C27, AG-C28, AG-C29, AG-C34, AG-C43, AG-C53, AG-C60, AG-C61, AG-S24, AG-S25, AG-S26, AG-S27, AG-S28; BOARDS: C-41, C-42; CLIENT: BR-33, BR-50, BD-02, BD-03, BD-04, BD-05, BD-06, VO-02, DR-02, DR-03, DR-04, AC-03, AC-08, AC-13, AC-14, AC-16; DOCK: CR-23; PORTAL: PH-07, PH-18, PLB-04, PLB-05, PLB-06, PLB-07, PLB-08, PLV-03, PLD-03, PLK-04, PAP-01, PC-04, PB-03, PB-05; SHELL: SH-44, SH-56; WORKBENCH: OB-W05, FM-W07, GA-W01, GA-W02, MA-W03, TS-W02, TS-W03, TS-W04, TS-W05, LR-W05, EM-W01, EM-W05, WP-W03, WP-W04 |
| DS-COMP-8 Door card | 31 | AGENCY: AG-P17; CLIENT: BR-44, WK-14, WK-23, MO-04, TR-08, AC-17; DOCK: CR-07, CR-08, CR-09; PORTAL: PH-15, PH-16, PH-17, PW-02, PW-06, PM-02, PT-08, PLK-03, PLK-06, PC-09; SHELL: SH-43, SH-55; WORKBENCH: WSH-17, CN-W12, OB-W02, OB-M07, SS-W05, SS-M08, SS3-M08, FN-M08, WP-W05 |
| DS-COMP-9 Verdict strip | 27 | AGENCY: AG-K4, AG-K5, AG-P7, AG-E6, AG-C8, AG-S7; CLIENT: BR-29, BR-30, WK-13, MO-05, TR-04; PORTAL: PH-13, PW-03, PT-04; WORKBENCH: WSH-10, WSH-11, TL-W01, OB-W01, FM-W01, SS-W01, TS-W01, LR-W01, CL-W01, EM-W02, FN-W01, RV-W01, WP-W01 |
| DS-COMP-10 Finding card | 9 | AGENCY: AG-K10, AG-P11, AG-E20, AG-C24, AG-S8; WORKBENCH: WSH-15, WSH-16, TL-W02, SI-W02 |
| DS-COMP-11 Recommendation card | 14 | AGENCY: AG-E15, AG-E16; BOARDS: P-41, P-48; CLIENT: RC-01, RC-02, RC-03, RC-04, RC-05, RC-06, RC-07, WK-17, MO-10; PORTAL: PM-05 |
| DS-COMP-12 Disclosure layer | 32 | AGENCY: AG-K15, AG-E18, AG-S15, AG-S17, AG-S19, AG-S22, AG-S23; CLIENT: BR-31, BR-43, BR-55, BR-56, BR-57, BR-58, WK-15; WORKBENCH: WSH-18, TL-M09, OB-M08, FM-M09, SS-M09, SS3-M09, SI-M09, SIR-M09, GA-M07, MA-M07, TS-M06, LR-M08, CL-M09, EM-M09, FN-M09, RV-M08, WP-M09, WPO-M09 |
| DS-COMP-13 List row | 52 | AGENCY: AG-P13, AG-P20, AG-C31, AG-C35, AG-C39, AG-C46, AG-C50, AG-C51, AG-C57, AG-X21; BOARDS: P-66, C-43; CLIENT: BR-41, MO-09, MO-11, TR-07, DSY-05, DSY-11, VO-08, AC-10, AC-11; DOCK: CL-07, CR-12, CR-13, CR-14, CR-15, DC-04, DC-16, DC-18, BM-02, PJ-05, PJ-08, NT-06; PORTAL: PT-07, PAC-03, PC-10, PC-11; SHELL: SH-60, SH-61; TASKS: DT-03, DT-04, DT-05, DT-12, TT-02, TA-09; WORKBENCH: WSH-25, FM-W08, SI-W01, SI-W07, SI-W08, FN-W03, RV-W05 |
| DS-COMP-14 Feed and ledger | 15 | AGENCY: AG-E11, AG-E12, AG-E14, AG-C41, AG-C42; BOARDS: L-05, L-06; CLIENT: WK-20; DOCK: CR-28, NT-08; TASKS: DT-20, DT-23, TT-05, TA-06; WORKBENCH: CN-W09 |
| DS-COMP-15 Message thread and composer | 15 | BOARDS: R-10, R-12, V-04, V-06; CLIENT: VO-04; DOCK: TM-04, TM-05, AI-09; PORTAL: PP-18, PP-20, PLV-05; TASKS: DT-15, DT-16, DT-18, DT-21 |
| DS-COMP-16 Filter and command bar | 17 | AGENCY: AG-P27, AG-C12, AG-C48, AG-S11, AG-A6; BOARDS: B-22, B-25, B-26, P-63, R-01, L-03, L-04, C-06, C-30, C-40, G-06; PORTAL: PP-09 |
| DS-COMP-17 Board table | 35 | BOARDS: B-15, B-16, B-17, B-18, B-20, B-21, B-24, P-20, P-21, P-22, P-23, P-24, P-25, P-26, P-27, P-28, P-32, P-33, P-35, P-64, C-10, C-11, C-12, C-13, C-14, C-15, C-16, C-17, C-21, C-23, C-25, C-31, C-32, M-05, M-08 |
| DS-COMP-18 Board card | 8 | BOARDS: R-02, R-04, R-06, V-01, V-02; PORTAL: PP-13, PP-14, PP-15 |
| DS-COMP-19 Stage strip | 6 | BOARDS: C-24, S-01, S-02, S-03, S-04, S-05 |
| DS-COMP-20 Roadmap columns | 5 | BOARDS: G-03, G-04, G-05; PORTAL: PG-03, PG-04 |
| DS-COMP-22 Dock panel body parts | 25 | DOCK: CL-05, CL-06, CL-13, CL-14, CR-02, CR-03, CR-10, CR-25, DC-13, DC-14, DC-15, DC-20, PJ-02, PJ-04, NT-02, NT-04, NT-05; TASKS: DP-26, DT-01, DT-08, DT-22, DA-01, TT-01, TA-02, TA-10 |
| DS-COMP-23 Panel tab set | 10 | DOCK: NT-03, AI-06, AI-07, AI-08; TASKS: DP-11, DP-12, DP-13, DT-14, TP-12, TT-04 |
| DS-COMP-25 Modal, sheet and drawer | 1 | CLIENT: BR-12 |
| DS-COMP-26 Form layout | 15 | AGENCY: AG-C54, AG-X20; CLIENT: BR-26, BR-45, RC-09, DSY-09, VO-06; PORTAL: PLV-07, PC-08, PB-09; TASKS: DT-11, DN-02, TP-10; WORKBENCH: CN-W11, SI-W04 |
| DS-COMP-27 Axis chart (line, column) | 7 | AGENCY: AG-E8, AG-S20; CLIENT: MO-07; WORKBENCH: WSH-30, WSH-31, SS-W02, GA-W04 |
| DS-COMP-28 Radial chart (donut, gauge, score dial) | 7 | AGENCY: AG-E23; WORKBENCH: WSH-32, WSH-33, WSH-34, TL-W05, CL-W04, WP-W02 |
| DS-COMP-29 Inline chart (sparkline, bar list, band track) | 11 | AGENCY: AG-P24b; CLIENT: WK-12, WK-22, AC-02; WORKBENCH: WSH-12, WSH-21, FM-W05, SS-W03, MA-W02, LR-W04, CL-W05 |
| DS-COMP-30 Project timeline (Gantt) | 3 | CLIENT: BR-51, BR-52, BR-53 |
| DS-COMP-31 Hero | 6 | CLIENT: BR-01, WK-10; PORTAL: PH-03, PH-04, PH-05, PH-06 |
| DS-COMP-32 Meeting card | 6 | CLIENT: BR-13, BR-14; PORTAL: PH-08, PH-09, PH-11, PC-12 |
| DS-COMP-33 Source rows | 7 | WORKBENCH: WSH-23, TL-W06, SS-W04, GA-W06, LR-W07, CL-W06, FN-W05 |
| DS-COMP-34 Journey map | 6 | AGENCY: AG-A4, AG-A7, AG-A8, AG-A9, AG-A10, AG-A12 |
| DS-COMP-36 Placeholder page | 0 | retired 27 September (AS-16); its eight rows are DS-PRIM-28 |
| DS-COMP-37 Report layouts | 3 | CLIENT: MO-03, MO-12, MO-13 |
| DS-COMP-38 Calendar and date grid | 4 | CLIENT: BR-21; PORTAL: PH-10, PB-07; TASKS: DP-20b |
| DS-COMP-39 Media tile | 1 | PORTAL: PH-19 |
| DS-COMP-40 Funnel chart | 1 | WORKBENCH: FN-W02 |
| DS-COMP-41 Rank grid | 0 | retired 27 September (OP-23, AS-15); LR-W03 is `content` (dropped) |
| DS-TASK-1 Task fact strip | 5 | TASKS: DP-14, DP-15, DP-16, DP-17, TP-08 |
| DS-TASK-3 Scope stamp | 2 | TASKS: DP-31, TA-08 |
| DS-TASK-4 Run summary | 2 | TASKS: DA-02, TA-01 |
| DS-TASK-5 Workflow list | 2 | TASKS: DA-03, DA-04 |
| DS-TASK-6 Output and evidence box | 5 | TASKS: DA-05, DA-06, TA-04, TA-05, TA-11 |
| DS-TASK-7 Gate box | 3 | AGENCY: AG-C56; TASKS: DA-07, TA-03 |
| DS-TASK-9 Token tracked | 2 | TASKS: DA-09, TA-12 |
| DS-TASK-10 Rank calculation | 2 | TASKS: DA-10, TP-09 |
| DS-TASK-11 Task record header and facts band | 3 | TASKS: TP-02, TP-06, TP-07 |
| DS-TASK-12 Execution graph | 2 | TASKS: TG-03, TG-06 |
| DS-TASK-13 Graph node card | 1 | TASKS: TG-05 |
| DS-TASK-14 Graph inspector | 1 | TASKS: TG-07 |

## Rows mapped to `content`

| Inventory | Id | Reason |
|---|---|---|
| AGENCY | AG-P9 | footnote copy, muted small text |
| AGENCY | AG-P14 | card footnote copy |
| AGENCY | AG-E17 | hash-open behaviour, no visual element |
| AGENCY | AG-C10 | footnote copy |
| AGENCY | AG-C33 | lede copy with derived counts |
| AGENCY | AG-C36 | meta sentences |
| AGENCY | AG-C38 | lede copy with derived counts |
| AGENCY | AG-C45 | lede copy with derived counts |
| AGENCY | AG-C47 | foot copy with derived figures |
| AGENCY | AG-C52 | meta note copy |
| AGENCY | AG-C58 | meta sentences |
| AGENCY | AG-C62 | meta sentences |
| BOARDS | B-02 | parser logic only, nothing drawn |
| BOARDS | P-34 | no visual; sort rule only |
| BOARDS | P-40 | summary sentence copy; no candidate |
| BOARDS | C-45 | counting rule for the read line |
| BOARDS | M-03 | a removal, nothing drawn |
| CLIENT | BR-38 | headline copy in a type style, no component look |
| CLIENT | TR-06 | attribution sentence, plain copy |
| CLIENT | DSY-03 | sandboxed iframe of client HTML, no own look |
| CLIENT | DSY-04 | explanatory copy line |
| CLIENT | AC-12 | copy line; its link is DS-PRIM-26 |
| DOCK | DK-15 | keyboard behaviour, nothing drawn |
| PORTAL | PT-06 | attribution sentence, plain copy |
| PORTAL | PAC-05 | foot copy line; its link is DS-PRIM-26 |
| SHELL | SH-50 | page-level wrapper, no look of its own |
| SHELL | SH-52 | launcher title copy, display type only |
| SHELL | SH-53 | lead paragraph copy, type role only |
| SHELL | SH-58 | no element drawn; missing control noted as defect |
| WORKBENCH | SH-27 | unwired hatch is a port instruction, not ported (DS-X4) |
| WORKBENCH | CN-W06 | one-line note text, a data value |
| WORKBENCH | SI-W03 | plain text-2 paragraph, no own look |
