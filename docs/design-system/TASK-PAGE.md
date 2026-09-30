<!-- Public edition, generated from the private design-system source by ticket C82's build and checked by the real-names check before it crossed. Do not edit it here; the source changes and the copy is run again. Screenshots and review records stay private, so they are not linked. -->

# Task page component map (TASK-PAGE)

Lane TASK-PAGE, design-system pass wave 2, 26 September 2026. Ticket: "Map the task page to components (#293)" on the map "Ops Astro design system". This file answers to `DIRECTION.md`: the owner asked for "each one of the components within the task when you click into the task page" to be "built as it is in the mockup", as the starting point to refine from. It maps every task element the inventories found to one canonical component, adds the task-only components the catalogue lacks, applies the decided rulings, and lists the defects not to copy. Plan and document only.

## How to read this

- **Scope.** The dock task panel (TASKS S1 to S4), the task page (S5 to S8), the dock Projects list as the way in (S9), plus what `TASKS-CROSSCHECK.md` and `ASTRA-TASKS-REVIEW.md` add (the entry points from boards, the 901 to 1279 tier, and the defects each lens found).
- **Component ids.** `DS-PRIM-n` is `catalogue/PRIMITIVES.md`, `DS-COMP-n` is `catalogue/COMPOSITES.md`, `DS-SIDE-n` is `SIDEBAR.md`, `DS-TOK-n` is `TOKENS.md` (the type column names the canonical text style, DS-TOK-107 to DS-TOK-129). `DS-TASK-n` is defined in this file, numbered from 1, never reused. Where a task-only component should fold into a catalogue entry at consolidation, its entry says so under "Home".
- **Element ids** are the inventory ids in `docs/mockup-inventory/TASKS.md` (DP, DT, DA, DN, TP, TT, TA, TG, TM) and its defect ids (D-01 to D-38). "XC" ids are the cross-check's; "X" ids are `TICKET-PLAN.md` section 5.
- **Construction** cites `dashboard-mockups` as `file:line`, under `assets/` unless a path is given. The mockup was never cleaned up. Its code is evidence of intent, not a pattern to copy.
- **Styling** is measured by `crop.mjs` (headless Chrome, 1480 wide unless stated), light then dark, with token names from its matcher. Where tokens alias (for example `--text`, `--text` and `--rule` are all #000 in light), the source rule's name is given. Dark re-resolves the same tokens throughout; only exceptions are called out.
- **Shots** live in `shots/task/<id>/<state>-<width>-<theme>.png`, each 40 KB or less. Crops marked "scale 0.5 to 0.7" were shrunk by the tool to fit the cap. Annotated shots carry dashed magenta boxes labelled with the component id (the magenta is an annotation colour, not a token).
- **Build rule.** Where a decided ruling and the mockup differ, build to the ruling and the row says so. No ruling on this page is open (since 27 September 2026, build-ready).

## How to read behaviour in this file

DIRECTION.md point 6: the look is canonical; "built as it is in the mockup" means every component, state, token, size and shot drawn here. What a task control does in the mockup shows a capability Ops Astro must really have. The build makes it real and tracked (the event or record it creates), listed in [`PLACEHOLDERS.md`](PLACEHOLDERS.md) under the control's catalogue id. The mockup's handlers, hooks, stored keys and demonstration wiring are evidence of intent, not the thing to build; until a capability is real, the control is drawn disabled with its reason (R56). Bugs (section 5) are never copied. Where a decided ruling says otherwise, the ruling wins (section 1).

## Counts

- Element rows mapped: **128** (S1 39, S2 23, S3 10, S4 6, S5 19, S6 13, S7 9, S8 4, S9 and the other ways in 5). Every TASKS.md element row, DP-01 to TM-04, is covered.
- Task-only components defined: **15** (DS-TASK-1 to DS-TASK-15). Four are proposed to fold into a catalogue entry at consolidation (DS-TASK-2, the toggle of DS-TASK-5, DS-TASK-8, DS-TASK-15).
- Rulings applied: **15** (R40, R41, R42, R43, R44, R45, R76, R60, R78, R37, R33, R29, R56, and, since build-ready on 27 September, R77 the timer on close, decided stop and log, and R63 the graph connector, answered by the owner: no style picked, the graph is likely replaced). None is open.
- Defect rows not to copy: **44** (TASKS D-01 to D-38 less the withdrawn D-13, cross-check-only D15, and the TICKET-PLAN task rows X1, X3, X6, X7, X9, X11, X12, X13, X15, X17, X19, X20, X33, X45, X47 to X52, merged where they name the same fault).
- Shots: 121 PNG in 52 folders under `shots/task/`, 2.97 MB in all, none over 40 KB.

---

## 1. Rulings that change what is drawn

Ticket "Task page rulings that change what is drawn" (#306), plus the other decided rulings that touch a task element. Source: `.local/design-system-2026-09-26/triage/triage.json`.

| Ruling | Status | What the build draws | Elements | Mockup today |
|---|---|---|---|---|
| R40 Tags, page link and pin | Answered (the owner) | All three ship as drawn: the tag field (DS-TASK-2), the page link value and its Link here / Relink control, and the star. | DP-10, DP-26 to DP-30, TP-10, TP-11 | Same (the plan had held pin back; the owner did not) |
| R41 Which conversation tab opens | Decided | **Internal**, on both the panel and the page. The tab set and its counts are otherwise as drawn. | DT-14, TT-04 | Panel opens on Client, page on Internal (D-07) |
| R42 Replies | Decided (one level deep is the owner's) | A **Reply** text button (DS-PRIM-1 `--text`) on each top-level message, revealed like the edit tools (DS-PRIM-2 `--reveal` rule, R37 at touch widths); it opens a composer (DS-COMP-15 composer) indented by the avatar gutter under that message. One level only: replies carry no Reply. A reply to a client message answers it, so its signal (DT-19) moves to "Answered" and the owed count drops. An @ in a reply notifies. Authors edit and delete their own replies with the same pencil and × as messages. | DT-16 to DT-19, DT-21, TT-04 | Replies render; nothing can write one (D-11); the client composer never answers (D-36) |
| R43 An agent task's status by hand | Decided | The Status select on an agent row offers the run ladder **plus On hold**. Complete stays with the board tick and the gate. | DP-25 | Ladder only (D-22) |
| R44 The gate's demonstration buttons | Decided | DS-TASK-7 keeps its layout exactly; Request changes and Approve exact vN call the real decide path Ops Astro already has. The "Demonstration state only" note and the demo rewrite of the action row are not ported. After a decision the action row shows the recorded decision (who, when), not "· demonstration". | DA-07, TA-03, TG-07 | Demonstration state only (`taskrun.js:313-323`) |
| R45 Ad hoc and Client access | Decided | Both ticks look and behave as drawn (DS-PRIM-7 in DS-TASK-1). Ad hoc is a task field; Client access reads and writes the existence of a share grant. | DP-16, DP-17, TP-08, TP-10 (Handling) | Both are task booleans |
| R76 Category against the permission lane | Decided | Category stays an editable select (DS-PRIM-5). The scope stamp (DS-TASK-3) reads its lane from the grant, read-only; editing Category never changes it. | DP-23, DP-31, TA-08 | Editing Category rewrites the stamp (D-30) |
| R60 The description font | Decided | The description is **sans everywhere** (DS-PRIM-4 default, `--type-body`). Mono stays only for the Agent brief (DS-PRIM-4 Mono). | DP-35, TT-01, DP-34 | Panel description is Chivo Mono 12 (D-09) |
| R78 Roll back to snapshot | Decided | Roll back is drawn where the mockup draws it, **unavailable** (DS-PRIM-1 disabled, with the not-connected treatment of R56) until the executor can restore a snapshot. The shipped record and its snapshot still show. | DA-06 | Drawn and dead (D-03) |
| R56 Unavailable controls | Decided | An unavailable control is drawn disabled with its reason; no control is drawn live and dead. | DA-06, DT-19 reaction chip | Several dead controls |
| R37 Hover-only controls at touch widths | Decided | Below 900 the hover reveals (time entry ×, message pencil and ×, the new Reply) show at rest; above 900 the reveal stays. | DT-12, DT-17, R42 Reply | Hover only |
| R33 The dock below 900 | Answered (the owner) | The Task panel is a sheet under a visible tab strip; the strip is never off screen. | S1 to S4 at 900 and 390 | The strip sits below the screen (X1) |
| R29 Start timer in the app strip | Decided | The app-strip timer ships disabled on the agency side; the task's own timer (DT-10) is the live one. Relevant to R77 option A below. | DT-10 | Strip timer unwired |
| **R77 A running timer when the panel closes or another task opens** | **Decided** (`PLACEHOLDERS.md`, "Behaviour decided"; the owner's sidebar law, the close "must REACH THE TENANT (... stop the timer ...)", `WIRING.md:2208-2210`) | **Stop and log:** closing the panel or opening another task stops the timer and prepends a time entry (DT-12, a DS-COMP-13 panel row) with the elapsed minutes, the task's Ad hoc default and the note "Logged when the panel closed". The elapsed time is never thrown away. The owner's sequencing: the timer is built in the Tasks phase, outside the first-slice (T1) demo. | DP-07, DT-10, DT-12 | The elapsed time is discarded (D-33, X52) |
| **R63 The execution graph's connection style** | **Answered by the owner, 26 September 2026: no style is picked** | Drawn with **Rail** for reference only. The visual depends on the agent harness chosen (decisions, "Harness adoption"; roadmap, "What follows the local demo"): if LangGraph or Langflow is adopted, its own workflow view may replace this graph. No connector work until then; the four other studies and the study bar's facets (TG-02) are not built. | TG-02, TG-06 | Five route studies |

---

## 2. Layout: the component tree

### 2.1 The dock task panel (S1 to S4)

The panel is a dock panel (DS-SIDE-7). The task body is `mountSideboard`'s `aside.sb` mounted inside the panel (`ui.js:6246-6285`). It is **not** a drawer of its own any more (see "Duplicates", item 3).

```
DS-SIDE-7 Dock panel (resident: task)
├─ DS-SIDE-8 Panel head   (task slots per DS-COMP-21: title · + · go to · open on board · open page · divider · back · forward · ×)
│   ├─ DS-PRIM-2 icon buttons ×4 (DP-02 to DP-05)
│   └─ DS-SIDE-9 back / forward / close (DP-06, DP-07)
└─ aside.sb › .sb__scroll                                   (body gutter 24, --s-5)
    ├─ name row: DS-PRIM-3 --inline (DP-08) · DS-PRIM-2 ask (DP-09) · DS-PRIM-2 star, pressed (DP-10)
    ├─ DS-COMP-23 Panel tab set, static: Team | Agent (DP-11 to DP-13)
    ├─ DS-TASK-1 Task fact strip (DP-14 to DP-17)
    ├─ DS-COMP-26 Form layout, inline form at 2 columns (.taskform.sb__fields)
    │   ├─ DS-PRIM-5 selects ×7 + date button (DP-18 to DP-25)
    │   ├─ DS-TASK-2 Tag field + page link row (DP-26 to DP-30)
    │   ├─ [Agent] DS-TASK-3 Scope stamp (DP-31) · DS-PRIM-25 stamp line (DP-32) · DS-PRIM-28 --inline (DP-33) · DS-PRIM-4 Mono (DP-34)
    │   └─ [Team]  DS-PRIM-4 Sans (DP-35, R60) · [draft] DN-02 helper line · DN-03/DN-04 actions
    └─ [data-sb-body]  (the seam: everything above never re-renders, §94.8)
        ├─ Team (S2): DS-COMP-22 ruled sections ×4
        │   ├─ Subtasks: label + count · DS-PRIM-3 --inline adder · DS-COMP-13 panel rows · DS-PRIM-1 --text fold
        │   ├─ Time: label + count · DS-PRIM-23 time track · DS-PRIM-1 secondary (timer) · log field row · DS-COMP-13 panel rows
        │   ├─ Conversation: DS-COMP-23 static · DS-COMP-15 thread · DS-COMP-15 composer (pinned to the foot)
        │   └─ History: label + reading line · DS-TASK-8 Task trail (folded)
        └─ Agent (S3): DS-COMP-22 ruled sections
            ├─ Current run: DS-TASK-4 Run summary, compact · DS-TASK-5 Workflow list (closed)
            ├─ Staged output / Live: DS-TASK-6 Output and evidence box
            ├─ Gate: DS-TASK-7 Gate box
            ├─ Skills and data source: DS-PRIM-11 outline chips · DS-PRIM-26 link
            ├─ Token tracked: DS-TASK-9
            └─ Rank calculation: DS-TASK-10 (section variant)
```

| Width | Panel placement | What changes inside |
|---|---|---|
| 1700 | Seated in the shell's third track, 550 wide beside an 836 minimum page (DS-SIDE-7 "Seated") | Nothing |
| 1480 | Floats over the page, 550 × 955, shadow `--shadow-overlay` (DS-SIDE-7 "Floating": the room, about 376, is under the 380 floor) | Nothing |
| 901 to 1279 | The stacked sheet tier (Astra, `WIRING.md:1237`; DS-SIDE-7 "sheet") | Nothing inside; the sheet height has a 220 floor |
| 900 | Full-width sheet, one panel, head at y 557 (R33: under a visible tab strip) | Field grid stays at 2 columns (select 342 wide) |
| 390 | Full-width bottom sheet, head at y 301, 24 gutters | Field grid 1 column (≤640, `app.css:3858`); the fact strip wraps to 2 rows; the run summary grid and the gate step note go to 1 column (`app.css:10573-10585`, `:12607-12622`) |

### 2.2 The task page (S5 to S8)

```
Shell (rail DS-SIDE-11 with Projects current · app strip DS-COMP-1 · page header DS-COMP-3 plain: h1 = task name)
└─ .content (page gutter 32)
    ├─ DS-TASK-11 Task record header (.tpr): crumb (DS-PRIM-26 · path · DS-PRIM-25 id · DS-PRIM-15 text · DS-PRIM-2 copy) · title · run line
    ├─ facts (.tpr__facts): DS-TASK-1 read-only · DS-TASK-10 line · DS-COMP-26 inline form, read-only · DS-PRIM-11 chips
    ├─ DS-COMP-23 static: Team | Agent (TP-12)
    ├─ Team (S5): DS-COMP-22 ruled sections: Description · Subtasks · Time · Conversation (no composer) · History (open)
    │   └─ panel doors: DS-PRIM-1 --text, centred (TT-06)
    └─ Agent (S6): DS-TASK-15 Agent perspective grid
        ├─ main: DS-TASK-4 hero · Execution map (DS-TASK-12 › DS-TASK-13 nodes › DS-TASK-14 inspector) · DS-TASK-6 staged
        │        · DS-TASK-7 gate + door · DS-TASK-6 knows · DS-TASK-6 artefacts · DS-TASK-8 ops activity
        └─ side (21rem): DS-TASK-3 + DS-TASK-6 scope · DS-COMP-13 record rows (what the run was given) · prose brief
                 · DS-TASK-6 asked-for · DS-PRIM-11 skills · DS-TASK-9 tokens
Missing / bare (S8): DS-COMP-3 plain ("Task not found") › DS-PRIM-30 error (unknown id) or DS-PRIM-28 --block (no id) › DS-PRIM-26 door
```

| Width | Page layout |
|---|---|
| 1480 and 1700 | Content 1168 wide (x 256 to 1424). Facts form 5 columns. Agent: main 808 + side 336 (21rem), gap 24 (`app.css:12691-12697`). The graph is wider than its 760 scroll box. |
| 900 | Facts form 2 columns. Agent: the side column stacks under main (below 1279). The graph becomes a vertical list: nodes full width, no SVG, a dependency sentence under each (`app.css:12580`, §111.6). |
| 390 | Facts form 1 column. The run hero's stats drop under the lead (`app.css:12699`). Must not overflow (D-16) or overlap (D-17). |

### 2.3 Annotated shots

One annotated shot per surface and theme. The long surfaces are split into pieces so each file stays under 40 KB and legible; the pieces tile the surface top to bottom.

| Surface | Light | Dark |
|---|---|---|
| S1 panel head and header | (screenshot, kept private) | (screenshot, kept private) |
| S2 Team pane | (screenshot, kept private) | (screenshot, kept private) |
| S3 Agent pane, above the seam | (screenshot, kept private) | (screenshot, kept private) |
| S3 Agent pane, run and staged | (screenshot, kept private) | (screenshot, kept private) |
| S3 Agent pane, gate to rank | (screenshot, kept private) | (screenshot, kept private) |
| S4 new task draft | (screenshot, kept private) | (screenshot, kept private) |
| S5 page header and facts | (screenshot, kept private) | (screenshot, kept private) |
| S5 Team: description, subtasks, time | (screenshot, kept private) | (screenshot, kept private) |
| S5 Team: conversation, history | (screenshot, kept private) | (screenshot, kept private) |
| S6 Agent: run hero | (screenshot, kept private) | (screenshot, kept private) |
| S6 Agent: staged output and gate | (screenshot, kept private) | (screenshot, kept private) |
| S6 Agent: what it knows, artefacts | (screenshot, kept private) | (screenshot, kept private) |
| S6 Agent: operational activity | (screenshot, kept private) | (screenshot, kept private) |
| S6 Agent: side: scope, what the run was given | (screenshot, kept private) | (screenshot, kept private) |
| S6 Agent: side: brief, what was asked for | (screenshot, kept private) | (screenshot, kept private) |
| S6 Agent: side: skills, tokens | (screenshot, kept private) | (screenshot, kept private) |
| S7 execution graph | (screenshot, kept private) | (screenshot, kept private) |
| S8 missing (unknown id) | (screenshot, kept private) | (screenshot, kept private) |
| S8 bare (no id) | (screenshot, kept private) | same treatment as missing |
| S9 dock Projects list (entry) | (screenshot, kept private) | (screenshot, kept private) |

Narrow layouts (unannotated; the panel whole, the page from its record header down to the named element):

| Layout | 900 light | 900 dark | 390 light | 390 dark |
|---|---|---|---|---|
| Panel (Team) | (screenshot, kept private) | (screenshot, kept private) | (screenshot, kept private) | (screenshot, kept private) |
| Page, Team (header to subtasks) | (screenshot, kept private) | (screenshot, kept private) | (screenshot, kept private) | (screenshot, kept private) |
| Page, Agent (hero to the second graph node) | (screenshot, kept private) | (screenshot, kept private) | (screenshot, kept private) | (screenshot, kept private) |

---

## 3. Element map

Columns: the inventory id; the element; the component that builds it, with variant and state; the text style; and what the build does differently from the mockup (a ruling or a defect id), if anything.

### S1. Dock task panel: head and shared header

| Id | Element | Component · variant · state | Type | Build note |
|---|---|---|---|---|
| DP-01 | Panel title "Task" + list icon | DS-SIDE-8 panel head, label slot; icon DS-PRIM-17 | DS-TOK-111 `--type-subheading` (Display 16.8 snaps to 16) | Always "Task"; the aria-label is the task name |
| DP-02 | New task `+` | DS-PRIM-2 icon button, default 26, in the head's view slots; hover `--accent` as DS-COMP-21 draws the head's link-outs | icon | – |
| DP-03 | Go to the linked section | DS-PRIM-2 default 26; shown only with `at` | icon | – |
| DP-04 | Open on the board (briefcase) | DS-PRIM-2 default 26 | icon | Goes to the agency board, not the client portal (D-12, X3) |
| DP-05 | Open on its own page | DS-PRIM-2 default 26 | icon | Canonical address from the one route table (X3) |
| DP-06 | Back / Forward | DS-SIDE-9 panel head button; disabled state (opacity .4) | icon | – |
| DP-07 | Close | DS-SIDE-9 close | icon | Esc from a field stops at the field (D-32, X15); the timer follows R77 (D-33) |
| DP-08 | Task name | DS-PRIM-3 text input `--inline` (display face), focus border `--accent` | DS-TOK-111 | – |
| DP-09 | Ask about this task | DS-PRIM-2 `--accent` hover variant (the ask sparkle, scale 1.12) | icon | Not on a draft |
| DP-10 | Pin (star) | DS-PRIM-2 default 26 + pressed (`aria-pressed`, glyph `--accent`) | icon | Ships (R40) |
| DP-11 | Team tab + count | DS-COMP-23 panel tab set, `static`; count DS-PRIM-13 `.cbadge--plain` | DS-TOK-120 idle, DS-TOK-121 selected | Count stays true after edits (D-31, X51) |
| DP-12 | Agent tab + count | DS-COMP-23 `static` + DS-PRIM-13; title via DS-PRIM-18 | as DP-11 | One count rule on panel and page: open gate first, then staged (D-07) |
| DP-13 | Tab mark | DS-COMP-23 selected mark, 2px `--accent`, left/width over `--dur-1` (220 ms) | – | – |
| DP-14 | Whose move | DS-TASK-1 cell, `derived` | label DS-TOK-126 `--type-eyebrow`; value DS-TOK-121 | Recomputes after a subtask tick (D-31) |
| DP-15 | Rank | DS-TASK-1 cell, `derived`; `none` state reads "not ranked" | value DS-TOK-124 `--type-data` | – |
| DP-16 | Ad hoc | DS-TASK-1 cell, `tick`: DS-PRIM-7 checkbox, default 18 | label DS-TOK-126 | R45: a task field |
| DP-17 | Client access | DS-TASK-1 cell, `tick`: DS-PRIM-7 | label DS-TOK-126 | R45: the tick is a share grant |
| DP-18 | Assignee | DS-PRIM-5 field select with DS-PRIM-16 person avatar 22; menu DS-PRIM-19 option menu (DS-COMP-24 `select menu`); in DS-COMP-26 inline form, 2 columns | DS-TOK-117 | Assign to AI reopens as AI, and the board and panel agree (D-21, D-29, X11); arrows move, Esc stays in the menu (X15) |
| DP-19 | Client | DS-PRIM-5 field select | DS-TOK-117 | Real client options (D-05) |
| DP-20 | Due date | DS-PRIM-5 date button (`.dp__btn`); no date: DS-PRIM-28 `--inline` sentence | DS-TOK-117 | `.dp__btn` needs a focus-visible rule (DS-PRIM-19 defects) |
| DP-20a | Date picker month bar | DS-PRIM-2 default in DS-PRIM-19 date picker (`.dp__pop`) | DS-TOK-121 | – |
| DP-20b | Date picker grid | DS-COMP-38 Calendar and date grid, `date picker grid` variant, in DS-PRIM-19's pop (id added by the Astra cross-check) | DS-TOK-124 | Arrow keys move across days (X17) |
| DP-20c | Quick picks | DS-PRIM-1 `--secondary --sm` | DS-TOK-123 | Count from the estate clock (D-34, X13) |
| DP-20d | Picker open and close | DS-PRIM-5 date button, open state (`--accent` border) | – | Esc closes the picker only (D-32) |
| DP-21 | Estimate | DS-PRIM-5 field select | DS-TOK-117 | – |
| DP-22 | Project | DS-PRIM-5 field select | DS-TOK-117 | Real board options (D-05) |
| DP-23 | Category | DS-PRIM-5 field select | DS-TOK-117 | R76: never rewrites the scope stamp (D-30, X50) |
| DP-24 | Stage | DS-PRIM-5 field select | DS-TOK-117 | – |
| DP-25 | Status | DS-PRIM-5 field select | DS-TOK-117 | R43: agent rows add On hold; one completion transition (D-37, X49) |
| DP-26 | Tags input | DS-TASK-2 tag field, query input (DS-PRIM-3 default) | DS-TOK-117 | R40 |
| DP-27 | Tag suggestion menu | DS-PRIM-19 option menu inside DS-TASK-2, first row `is-on` | DS-TOK-117 | Keep its Esc handling: it is the model the selects should copy |
| DP-28 | Tag chip | DS-PRIM-11 `--soft` + remove × (DS-PRIM-2 compact) inside DS-TASK-2 | DS-TOK-128 `--type-chip` | – |
| DP-29 | Page link value | DS-PRIM-26 link (`.sb__addr`, mono); empty "nothing yet" DS-PRIM-28 `--row` | DS-TOK-124 | R40 |
| DP-30 | Link here / Relink | DS-PRIM-1 `--text` (icon only, `.sb__relink`) | icon | R40 |
| DP-31 | Scope stamp (Agent) | DS-TASK-3 | DS-TOK-124 | R76: lane from the grant, read-only |
| DP-32 | Context snapshot line | DS-PRIM-25 `.stamp` with a leading DS-PRIM-17 icon | DS-TOK-124 | The icon stays inline with the text (D-25) |
| DP-33 | Invitation | DS-PRIM-28 `--inline` | DS-TOK-120 | – |
| DP-34 | Agent brief | DS-PRIM-4 textarea, Mono variant, 10 rows | DS-TOK-124 | R60 keeps mono here only |
| DP-35 | Description (Team) | DS-PRIM-4 textarea, Sans default, 4 rows | DS-TOK-117 | R60: sans (mockup mono, D-09) |

### S2. Dock task panel: Team pane

| Id | Element | Component · variant · state | Type | Build note |
|---|---|---|---|---|
| DT-01 | Subtasks head "N of M done · P%" | DS-COMP-22 section label + count line (`.sb__k`, `.sb__meta`) inside a DS-COMP-22 ruled section (`.sb__sect`: grid gap 12, top 1px `--border`; measured padding 12 0 8 in the panel, 24 on the page's main column) | DS-TOK-126 label; DS-TOK-124 count | – |
| DT-02 | Add subtask | DS-PRIM-3 `--inline` (underline only) + DS-PRIM-17 plus | DS-TOK-117 | – |
| DT-03 | Open subtask row | DS-COMP-13 list row, `panel row`: DS-PRIM-7 tick + text + DS-PRIM-16 person 22 (or the agent sparkle) | DS-TOK-117 | – |
| DT-04 | Gate step | DS-COMP-13 `panel row`, state `gate step`: leading DS-PRIM-17 eye, no tick, trailing DS-PRIM-25 key tag note | DS-TOK-117; note DS-TOK-124 | At 390 the note wraps, never overlaps (D-17, X19); the note names where staged output is (Agent tab) |
| DT-05 | Archived / superseded row | DS-COMP-13 `panel row`, state `archived` (text `--text-2`) | DS-TOK-117 | – |
| DT-06 | Show N completed / Hide | DS-PRIM-1 `--text` (`.tt__more`) | DS-TOK-124 | – |
| DT-07 | Nothing left | DS-PRIM-28 `--inline` | DS-TOK-120 | – |
| DT-08 | Time head | DS-COMP-22 label + count line | DS-TOK-126, DS-TOK-124 | – |
| DT-09 | Burn bar | DS-PRIM-23 time track (`.tt__bar`, 4px); over estimate `is-over` `--danger` | – | – |
| DT-10 | Start timer | DS-PRIM-1 `--md` (38, DR-21; drawn stretched); running state shows the elapsed readout | DS-TOK-123 | R77 (decided: close stops and logs) |
| DT-11 | Log field + Log | DS-COMP-26 `panel form` field row: DS-PRIM-3 default + DS-PRIM-1 `--secondary --sm` | DS-TOK-117 | – |
| DT-12 | Time entry | DS-COMP-13 `panel row`: DS-PRIM-16 + date + note + minutes + × (DS-PRIM-2 compact, `--reveal`, `--danger` hover) | date DS-TOK-124; note DS-TOK-120 | Note opens by Enter too (D-10, X17); × at rest below 900 (R37) |
| DT-13 | Show N more entries | DS-PRIM-1 `--text` | DS-TOK-124 | – |
| DT-14 | Conversation tabs | DS-COMP-23 `static` + DS-PRIM-13 counts | DS-TOK-120 / 121 | R41: opens on Internal |
| DT-15 | Thread box | DS-COMP-15 `thread` in a scroll box (floor three 2-line messages, cap min(60vh, 32rem)); empty DS-PRIM-28 `--inline` | DS-TOK-120 | Empty copy says "task", not "project" (D-23) |
| DT-16 | Message | DS-COMP-15 `thread` message (DS-PRIM-16 avatar, name, stamp, "team only" marker, pin chip) | name DS-TOK-121; stamp DS-TOK-122; text DS-TOK-117 | – |
| DT-17 | Edit / Delete | DS-PRIM-2 compact 22, `--reveal`; edit uses DS-PRIM-4 | icon | At rest below 900 (R37) |
| DT-18 | Replies | DS-COMP-15 `thread`, nested one level by the avatar gutter | as DT-16 | R42: Reply control and composer added; replies survive load (D-35, X47) |
| DT-19 | Message signal | DS-PRIM-15 status mark, text; reaction DS-PRIM-11 chip | DS-TOK-124 | Display only, no pointer and no instruction in its title, or drawn unavailable (D-04, R56); a reply answers (D-36) |
| DT-20 | All activity rows | DS-TASK-8 task trail, `activity` | DS-TOK-124 meta | – |
| DT-21 | Composer | DS-COMP-15 composer: DS-PRIM-3 on the paper field ground (the drawn `--sunk` ground is dropped, DR-25) + DS-PRIM-1 `--primary --sm` "Send" | DS-TOK-117 | Enter sends (D-10, X17); disabled on All activity as drawn |
| DT-22 | History head | DS-COMP-22 label + reading line | DS-TOK-126, DS-TOK-124 | – |
| DT-23 | History trail | DS-TASK-8 task trail, `history`, folded (DS-PRIM-1 `--text` toggle) | DS-TOK-124 | – |

### S3. Dock task panel: Agent pane

| Id | Element | Component · variant · state | Type | Build note |
|---|---|---|---|---|
| DA-01 | Current run head | DS-COMP-22 label + reading line | DS-TOK-126, DS-TOK-124 | – |
| DA-02 | Run summary | DS-TASK-4 run summary, `compact`; tone by state | DS-TOK-121 sentence; cells DS-TOK-120 | – |
| DA-03 | Workflow toggle | DS-TASK-5 toggle (DS-PRIM-25 key tag + DS-PRIM-31 chevron), closed in the panel | DS-TOK-126 | – |
| DA-04 | Workflow rows | DS-TASK-5 rows; state DS-PRIM-15 text; failure DS-PRIM-30 | DS-TOK-120 | – |
| DA-05 | Staged output | DS-TASK-6 output box, `staged` (kinds diff, pr, ad, preview); PAUSED DS-PRIM-15 chip | DS-TOK-120, DS-TOK-124 | PAUSED sits at its content width (D-20) |
| DA-06 | Live / Was live | DS-TASK-6 `live` / `was live` + DS-PRIM-1 `--secondary --sm` Roll back, **disabled** | DS-TOK-123 | R78, R56 (D-03, X9) |
| DA-07 | Gate box | DS-TASK-7, `armed` / `stale` | DS-TOK-126 word; DS-TOK-120 | R44: real decide path, no demo note |
| DA-08 | Skills and data source | DS-PRIM-11 `--outline` chips with a doc glyph; DS-PRIM-26 link | DS-TOK-128 | – |
| DA-09 | Token tracked | DS-TASK-9 | DS-TOK-124 | – |
| DA-10 | Rank calculation | DS-TASK-10, `section` | DS-TOK-122 | – |

### S4. New task (the draft)

| Id | Element | Component · variant · state | Type | Build note |
|---|---|---|---|---|
| (head) | Draft head | DS-SIDE-8 with the draft's slots: go to, +, open on board; no star, sparkle, strip or tab counts | – | – |
| DN-01 | Name | DS-PRIM-3 `--inline`, focused on open | DS-TOK-111 | – |
| DN-02 | Guess sentence | DS-COMP-26 inline form helper line (`.tf__why`) | DS-TOK-120 | – |
| DN-03 | Create task | DS-PRIM-1 `--primary --sm` in the form's actions row (`.sb__nfoot`) | DS-TOK-123 | Writes a real task with every field; client from the page's scope or empty (D-01, D-02, D-26, D-27, X6, X7) |
| DN-04 | Cancel | DS-PRIM-1 `--ghost --sm` | DS-TOK-123 | – |
| DN-05 | Draft panes | as S2 and S3 with their empty states | – | Everything chosen on the draft is kept (D-27) |

### S5. Task page: header, facts, Team perspective

| Id | Element | Component · variant · state | Type | Build note |
|---|---|---|---|---|
| (topbar) | Page header, h1 = task name | DS-COMP-3 `plain` | DS-TOK-109 `--type-title` | Back button must not throw (D-24, shell) |
| TP-01 | Crumb "Projects →" | DS-PRIM-26 door link (`.sb__addr` + door mark) in DS-TASK-11 | DS-TOK-124 | Canonical address (X3) |
| TP-02 | Crumb trail | DS-TASK-11 crumb text, `--text-muted` | DS-TOK-117 | – |
| TP-03 | Task id | DS-PRIM-25 key tag | DS-TOK-126 | The id prints as stored, not in capitals (D-14, X20) |
| TP-04 | State word | DS-PRIM-15 status mark, text (`.spill[data-tone]`) | DS-TOK-117 | Complete reads done, `--success` (D-06, X20) |
| TP-05 | Copy address | DS-PRIM-2 default; `copied` state swaps to a check for 1.2 s | icon | The check shows only on success (D-38, X51); the mockup's 13 × 15 hit area is drift, build the DS-PRIM-2 default square (FA-TASKS-42) |
| TP-06 | Title | DS-TASK-11 title | DS-TOK-107 `--type-display` (mockup weight 600, style 500: drift) | – |
| TP-07 | Run line | DS-TASK-11 run line (`.card__sub`) | DS-TOK-120 | – |
| TP-08 | Fact strip | DS-TASK-1, `read-only` (ticks are `span.sbbox`) | as DP-14 to DP-17 | No pointer on inert marks (D-08, X45) |
| TP-09 | Calc line | DS-TASK-10, `line` | DS-TOK-122 | – |
| TP-10 | Read-only field grid | DS-COMP-26 inline form, read-only (5 / 2 / 1 columns), values `.sb__state`; Handling as DS-PRIM-11 `--outline` chips | DS-TOK-117; labels DS-TOK-126 | R45 (Handling), R40 (Page link) |
| TP-11 | Tag chips | DS-PRIM-11 `--soft`, no remove | DS-TOK-128 | R40 |
| TP-12 | Team / Agent switch | DS-COMP-23 `static` + DS-PRIM-13 count | DS-TOK-120 / 121 | Same counts as the panel (D-07) |
| TT-01 | Description | DS-COMP-22 ruled section; prose; empty DS-PRIM-28 `--inline` | DS-TOK-117 | R60 (already sans here) |
| TT-02 | Subtasks | DS-COMP-13 `panel row`, inert ticks (DS-PRIM-7 static); all blocks open | DS-TOK-117 | No pointer on inert ticks (D-08) |
| TT-03 | Time | DS-PRIM-23 time track + DS-COMP-13 rows, no × | DS-TOK-124 | – |
| TT-04 | Conversation | DS-COMP-23 `static` + DS-COMP-15 `thread`, no composer | as DT-16 | R41 Internal; R42 replies are written in the panel |
| TT-05 | History | DS-TASK-8 `history`, open | DS-TOK-124 | – |
| TT-06 | Panel doors | DS-PRIM-1 `--text`, centred, full width | DS-TOK-124 | – |

### S6. Task page: Agent perspective

| Id | Element | Component · variant · state | Type | Build note |
|---|---|---|---|---|
| (layout) | Main and side columns | DS-TASK-15 | – | – |
| TA-01 | Run hero | DS-TASK-4 run summary, `hero` (2×2 stats) | head DS-TOK-119; numbers mono 20 (see DS-TASK-4 drift) | – |
| TA-02 | Execution map section | DS-COMP-22 label + reading line around DS-TASK-12 | DS-TOK-126 | Say "not editable" once (D-19, X33) |
| TA-03 | Human gate section | DS-TASK-7 + DS-PRIM-1 `--text` door | as DA-07 | R44 |
| TA-04 | What it knows so far | DS-TASK-6 `knows` | DS-TOK-120 | – |
| TA-05 | Artefacts and evidence | DS-TASK-6 `artefact` | DS-TOK-120, DS-TOK-124 | "Checks passed" derives from two different counts (D-18, X12) |
| TA-06 | Operational activity | DS-TASK-8 `ops` | DS-TOK-124 | – |
| TA-07 | No-run body | DS-PRIM-28 `--inline` (four sentences) | DS-TOK-120 | – |
| TA-08 | Granted scope | DS-TASK-3 + DS-TASK-6 `scope` | DS-TOK-124 | R76 |
| TA-09 | What the run was given | DS-COMP-13 `record row` (`.xb__row`) + DS-PRIM-26 links | DS-TOK-120 | – |
| TA-10 | Agent brief (rendered) | prose block in a DS-COMP-22 ruled section | DS-TOK-117 | – |
| TA-11 | What was asked for | DS-TASK-6 `asked-for` | DS-TOK-120 | – |
| TA-12 | Skills / tokens | as DA-08, DS-TASK-9 | – | – |

### S7. The execution graph

| Id | Element | Component · variant · state | Type | Build note |
|---|---|---|---|---|
| TG-01 | Study bar label | DS-PRIM-25 key tag in DS-TASK-12 bar | DS-TOK-126 | Deleted at port with TG-02 (R63) |
| TG-02 | Route facets | DS-PRIM-10 `.facet`, pressed = `--accent` border | DS-TOK-120 | R63 answered (no style picked); the facets go, and the whole graph is likely replaced with the harness decision |
| TG-03 | Legend | DS-TASK-12 legend | DS-TOK-126 | – |
| TG-04 | Stage labels | DS-PRIM-25 key tag + DS-PRIM-27 rule | DS-TOK-126 | – |
| TG-05 | Node card | DS-TASK-13, default / hover / focus-visible / pressed; tone by state | DS-TOK-121 title; DS-TOK-124 | – |
| TG-06 | Connectors | DS-TASK-12 connector layer (Rail) | – | An approved gate's out-edge is not drawn blocked (D-38, X51) |
| TG-07 | Inspector | DS-TASK-14; gate card DS-TASK-7 `.gate` | DS-TOK-111 title | Preselection scrolled into view (D-15, X33); the digest wraps (D-16, X19) |
| TG-08 | Orphan note | DS-PRIM-28 `--inline` | DS-TOK-120 | – |
| TG-09 | Empty states | DS-PRIM-28 `--inline` | DS-TOK-120 | – |

### S8. Missing and bare

| Id | Element | Component · variant · state | Type | Build note |
|---|---|---|---|---|
| TM-01 | "Task not found" | DS-COMP-3 `plain` | DS-TOK-109 | – |
| TM-02 | Unknown id sentence | **DS-PRIM-30 error state** (the mockup draws DS-PRIM-28 `--block`); the id in DS-PRIM-25 key tag | DS-TOK-117 | It is an error, not an empty state (DS-PRIM-28 defects); the id prints as typed (D-14) |
| TM-03 | No id sentence | DS-PRIM-28 `--block` | DS-TOK-117 | – |
| TM-04 | Door to the board | DS-PRIM-26 door link | DS-TOK-124 | – |

### S9 and the other ways in (entry only)

| Id | Element | Component | Build note |
|---|---|---|---|
| S9 | Dock Projects list | DS-SIDE-7 panel; DS-SIDE-8 head (todos slots); DS-COMP-22 token search; DS-COMP-13 `panel row` (task row 488 × 42); DS-PRIM-7 task-list size; DS-PRIM-16; DS-PRIM-14 priority line; empty DS-PRIM-28 `--inline --filtered` | A row opens the task itself, not a copy (D-28, X48); owned by the DOCK inventory |
| BOARDS P-49 | Review card "View plan" | DS-PRIM-1 `--secondary --sm` + icon; opens S1 | – |
| BOARDS R-09 | "View task" | DS-PRIM-1 `--secondary --sm`; opens S1 | – |
| BOARDS M-08 | Board row click | DS-COMP-17 board table row; opens S1 | – |
| Astra S1 | Row play and add-subtask, timeline bar, contextual task icon (`data-task`) | DS-PRIM-2 `--reveal` (play, plus); DS-COMP-30 bar; DS-PRIM-2 default (task icon) | The contextual icon opens S4 (a new task draft). The `data-task` document hook is how the mockup wires it, and reusing it caused a bug (WIRING §112.6): build the capability, not the hook (`PLACEHOLDERS.md`, DS-PRIM-2) |

---

## 4. Task-only components

Each entry: purpose, anatomy, variants, states, styling (measured, tokens), shots, construction, usages, drift, and its home.

### DS-TASK-1 Task fact strip

- **Purpose.** The task's derived facts and its two handling ticks in one row above the fields: Whose move, Rank, Ad hoc, Client access.
- **Anatomy.** `.mstrip` (flex, wrap) > `.mstrip__c` × 3 or 4 > `.mstrip__k` label (with a muted "derived" suffix on the derived cells) + `.mstrip__v` value. Derived cells are `<output>`; tick cells wrap a DS-PRIM-7 checkbox.
- **Variants.** `panel` (editable ticks); `read-only` (the page: ticks are `span.sbbox`, no pointer); `complete` (no Whose move cell, three cells).
- **States.** Rank `none` ("not ranked", italic `--text-muted`); Whose move by family: the glyph takes the tone (agent `--accent`, review `--warning`, team `--text-2`), never a fill; tick on/off (DS-PRIM-7).
- **Styling.** 501 × 58 in the panel, 1168 × 58 on the page. Flex, gap 12 × 32 (`--s-3` × `--s-6`), padding-bottom 16 and margin-bottom 16 (`--s-4`), bottom rule 1px `--border` (#000 12% light; dark re-resolves). Label Chivo Mono 12 uppercase `--text-muted`, tracking .04em (DS-TOK-126 `--type-eyebrow`, which is 300 and .02em: drift, snap to the style); value Funnel Sans 13 `--text` (DS-TOK-120), Whose move 500 (DS-TOK-121); Rank tabular Chivo Mono (DS-TOK-124). At 390 the four cells wrap to two rows.
- **Shots.**

  | Variant | Width | Light | Dark |
  |---|---|---|---|
  | panel | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | panel | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | read-only (page) | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | complete (3 cells) | 1480 | (screenshot, kept private) | – |

- **Construction.** `sbStrip` `ui.js:4462-4513`; CSS `app.css:10753-10790`; page lift `recordHeaderBits` `taskpage-team.js:247-286`, `deaden` `taskpage-team.js:167`.
- **Usages.** DP-14 to DP-17, TP-08.
- **Drift.** The page's deadened ticks keep `cursor: pointer` (D-08): drop. `.mstrip__sel` (`app.css:10790`) is a select dialect with no call site: drop.
- **Home.** Task-only.

### DS-TASK-2 Tag field

- **Purpose.** Add and remove tags from the shared vocabulary; typed text is never a tag until it is chosen.
- **Anatomy.** `.tgs` (flex wrap, gap 8) > `.tgs__chips` (display contents) > DS-PRIM-11 `--soft` chip + `.tgs__x` remove; `.tgs__in` > `.tgs__q` input (DS-PRIM-3) > `.tgs__menu` (DS-PRIM-19 option menu, min 11rem) with a `.tgs__new` "new tag" row keyed in mono.
- **Variants.** `edit` (panel); `read-only` (page TP-11: chips only, no ×, no input).
- **States.** Menu closed; menu open (first row `is-on`, hover `--surface-2`); empty list hides the menu (no empty box); "new tag" row only for a string not already in the vocabulary; × hover and focus-visible `--accent`.
- **Styling.** Input as a field: Funnel Sans 14, 1px `--border`, 166 × 38 at 1480. Chip Chivo Mono 11 uppercase .06em `--text`, pill (DS-TOK-128). Menu rows 164 × 38, Sans 14.4 (snap to DS-TOK-117). New-tag key 11 uppercase `--text-muted`.
- **Shots.**

  | State | Light | Dark |
  |---|---|---|
  | default (tags + page link row) | (screenshot, kept private) | (screenshot, kept private) |
  | menu open | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `sbTagsIn` `ui.js:4348-4360`; wiring `ui.js:6943-6993`; CSS `app.css:11163-11177`.
- **Usages.** DP-26 to DP-28, TP-11.
- **Drift.** None inside the task. It is a near relative of DS-COMP-22's `token search` (`.tsearch`) and DS-PRIM-11's filter tag.
- **Home.** Folded (consolidation, 26 September 2026): alias of DS-COMP-22, variant `tag field` (`CATALOGUE.md` alias table). This entry stays as the variant's spec; keep the Esc handling (it is the model the selects should copy).

### DS-TASK-3 Scope stamp

- **Purpose.** Say, read-only, what an agent may touch on this task: client × lane × clearance, and who holds live leases.
- **Anatomy.** `.mstamp` (grid, gap .3rem, padding-top 12) > label (`tf__k`) > `.mstamp__v` (lock glyph, `.mstamp__p` parts, `.mstamp__x` ×, a clearance DS-PRIM-11 `--outline` chip) > `.mstamp__say` line with a DS-PRIM-26 link to the access ledger.
- **Variants.** `panel` (above the seam, Agent pane only, agent rows only); `page` (lifted into Granted scope, TA-08, with write access, grant and constraints rows from DS-TASK-6 `scope`).
- **States.** Agent row only; no grant: "No scope has been issued on this task yet."; person's task: the sentence that the Team fields are its scope.
- **Styling.** Parts Chivo Mono 12 `--text-2`; × and lock `--text-muted`; say-line Chivo Mono 12 `--text-muted` (all DS-TOK-124). The chip keeps its `--accent` outline in dark.
- **Shots.** (screenshot, kept private) (screenshot, kept private)
- **Construction.** `sideboard` `ui.js:5473-5489`; CSS `app.css:8814-8820`; page `scopeBody` `taskpage-agent.js:153-214`.
- **Usages.** DP-31, TA-08.
- **Drift.** The lane part reads Category (`ui.js:5480`), so editing Category rewrites it (D-30): build to R76, lane from the grant.
- **Home.** Task-only.

### DS-TASK-4 Run summary

- **Purpose.** The current run in one block: attempt, executor, state, a sentence, and four facts.
- **Anatomy.** `compact` (`.trs`): `.trs__top` (attempt · executor, DS-PRIM-15 state) > `.trs__say` sentence > `.trs__grid` 2 × 2 cells (`tf__k` label + value). `hero` (`.tph`): `.tph__lead` (state spill, run id line, `.tph__head` headline) beside `.tph__stats` 2 × 2 (`.tph__n` number + `.tph__of` unit + label).
- **Variants.** `compact` (panel, DA-02); `hero` (page, TA-01).
- **States.** Tone by `data-tone`, drawn only as the 3px left rule: gate `--warning`, run `--accent`, done `--success`, bad `--danger`, otherwise `--border-strong`. Hero cells for elapsed and tokens are omitted when unknown. At ≤640 the compact grid and the hero stats go to one column (hero stats under the lead).
- **Styling.** Compact: 1px `--border`, 3px left rule, padding 12, gap 8; sentence Sans 13 600 (DS-TOK-121 snaps 600 to 500: drift); cells Sans 13 `--text` with inner rules 1px `--border`. Hero: 808 × 135 at 1480; lead padding 16, headline Sans 16 600 (DS-TOK-119 `--type-card-title`, 15 600); stats cells padding 12 × 16, numbers **Chivo Mono 20** `--text` (no canonical mono number style: see drift), unit Sans 13 `--text-muted`.
- **Shots.**

  | Variant | Width | Light | Dark |
  |---|---|---|---|
  | compact, gate | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | compact, gate | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | hero, gate | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | hero, gate | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | hero, stale (bad) | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | hero, running | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `runSummary` `taskrun.js:114-152`, `runHero` `taskrun.js:246-281`; CSS `app.css:12607-12622`, `:12672-12701`.
- **Usages.** DA-02, TA-01.
- **Drift.** Two drawings of one fact block: keep as two variants of one component. The hero's mono 20 numbers have no text style (TOKENS has Display numbers only): ruled by DR-6: kept as a named style (Chivo Mono 20), the one mono number exception to TICKET-PLAN R53. `.tph__stat` is a fourth stat dialect (COMPOSITES DS-COMP-6 drift): it stays inside this component, not in DS-COMP-6.
- **Home.** Task-only (a left-rule card built on DS-PRIM-21).

### DS-TASK-5 Workflow list

- **Purpose.** The run's jobs in order, parallel siblings grouped, behind a toggle.
- **Anatomy.** `.wf` > `button.wf__toggle` (DS-PRIM-25 key tag "View N-job workflow" + DS-PRIM-31 chevron) > `.wf__list` > `.wf__row` (ring mark `.wf__mark`, body: title + "KEY · owner · typed output vN", DS-PRIM-15 state) and `.wf__par` groups ("Run in parallel", 2px `--accent` 45% left rule).
- **Variants.** One. Closed in the panel, open where a caller passes `open`.
- **States.** Toggle default, hover (`--accent`), focus-visible (global ring), expanded (`aria-expanded`, chevron up). Row mark by tone: done `--success` with a check, run `--accent`, gate `--warning`, bad `--danger`, wait dashed; `wf__fail` line 11 `--danger`.
- **Styling.** Toggle: full width, padding 8 0, top 1px `--border`, `--text-muted`. Rows: grid auto / 1fr / auto, gap 8, padding 8 0, top 1px `--border`. Mark .95rem ring, 1.5px. Title Sans 13 `--text` (DS-TOK-120).
- **Shots.**

  | State | Light | Dark |
  |---|---|---|
  | open | (screenshot, kept private) | (screenshot, kept private) |
  | toggle default / hover / focus-visible | (screenshot, kept private) (screenshot, kept private) (screenshot, kept private) | – |

- **Construction.** `jobWorkflow` `taskrun.js:153-207`; toggle delegate `taskrun.js:301-312`; CSS `app.css:12625-12651`.
- **Usages.** DA-03, DA-04.
- **Drift.** The ring mark is a sixth status-dot dialect (DS-PRIM-14 has `.sline` and `.nr__dot`). Keep here as the job mark; flag at consolidation.
- **Home.** Task-only for the rows. The toggle is DS-COMP-12's disclosure pattern (consolidation, 26 September 2026: partial fold, `CATALOGUE.md`).

### DS-TASK-6 Output and evidence box

- **Purpose.** One framed box for "what exactly changes if you say yes" and the other evidence blocks of a run. The comment at `app.css:8823-8835` names the intent: one frame, many bodies.
- **Anatomy.** Section head (DS-COMP-22 label + reading line, e.g. "built · nothing published") > `.sout__box` (1px `--border`, padding 12, grid gap 12) > body rows `.sout__row` (`tf__k` key + `.sout__t` text or `.sout__v` mono value) > `.sout__say` footnote.
- **Variants (bodies).** `staged` with four kinds: `diff` (where, Now / Would become, old struck, new behind a 2px `--success` rule), `pr` (repo, title, files, checks), `ad` (account, groups, PAUSED chip, spend / CPA / band), `preview` (URL, built, note); `live` and `was live` (Closed against, Snapshot, Roll back); `knows` (TA-04); `artefact` (TA-05); `scope` (TA-08); `asked-for` (TA-11).
- **States.** "Staged only, nothing has been applied" or "Applied.". Each body has its own empty sentence (DS-PRIM-28 `--inline`).
- **Styling.** Box 760 wide on the page main, 501 in the panel. Where / meta Chivo Mono 12 `--text-muted` (DS-TOK-124); text Sans 13 / 1.5 `--text` (DS-TOK-120); value mono 12 `--text-2`; say Sans 13 `--text-muted`.
- **Shots.**

  | Body | Light | Dark |
  |---|---|---|
  | staged, ad (panel) | (screenshot, kept private) | (screenshot, kept private) |
  | knows (page) | (screenshot, kept private) | (screenshot, kept private) |
  | artefact (page) | see annotated S6 c | see annotated S6 c |
  | scope, asked-for (page side) | see annotated S6 e, f | see annotated S6 e, f |

- **Construction.** `stagedBlock` `ui.js:5696-5758`, `stagedDiff` `ui.js:5617`; page bodies `taskpage-agent.js:153-353` (`scopeBody`, `sharedStateBody`, `snapshotBody`, `artefactBody`); CSS `app.css:8823-8850`.
- **Usages.** DA-05, DA-06, TA-04, TA-05, TA-08, TA-11.
- **Drift.** The PAUSED chip stretches to the row (D-20): drop. "Checks passed N of N" counts one thing twice (D-18).
- **Home.** Task-only. It is the house "evidence box". A later page that shows staged output reuses it.

### DS-TASK-7 Gate box

- **Purpose.** The human approval gate: what is waiting, on whom, bound to which exact version, and the two decisions.
- **Anatomy.** `.gatebox` (1px `--warning`, padding 12, gap 8) > `.gate` card (square mark, `.gate__word` "HUMAN APPROVAL GATE" or "GATE STALE", `.gate__say` "<title>, waiting on <owner>.") > `.sout__box` facts (Exact artefact vN + short digest, Approval unlocks, Why it waits, Invalidated) > `.gatebox__acts` (DS-PRIM-1 `--secondary --sm` Request changes, DS-PRIM-1 `--primary --sm` Approve exact vN).
- **Variants.** `armed` (mark filled `--warning`, box `--warning`); `stale` (`.gatebox--stale`: box `--border-strong`, mark empty, the buttons replaced by the sentence that a stale gate cannot be approved). The inspector (TG-07) uses the `.gate` card alone with "Binds <artefact> · <digest>".
- **States.** Undecided; decided (R44: the action row shows the recorded decision); stale.
- **Styling.** `.gate`: flex, gap 16, 1px `--border` with a 3px left rule (`--warning` armed, `--text-muted` otherwise), `--surface` ground, padding 16 × 24; mark .7rem square; word Chivo Mono 12 uppercase `--text` (DS-TOK-126); say Sans 13 `--text-2`, max 74ch.
- **Shots.**

  | Variant | Width | Light | Dark |
  |---|---|---|---|
  | armed | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | armed | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | stale | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `gateBox` `taskrun.js:208-245`; demo wiring `taskrun.js:313-323` (not ported, R44: each decision is real and recorded, `PLACEHOLDERS.md`, DS-TASK-7); CSS `.gate` `app.css:8454-8465`, `.gatebox` `app.css:12654-12657`.
- **Usages.** DA-07, TA-03, TG-07.
- **Drift.** COMPOSITES DS-COMP-5 lists `.gate` (AG-C56) as a strip dialect to drop in favour of the banner. The task gate card is the same rule. Settled at consolidation: `.gate` has one home, this component's card (`CATALOGUE.md`, alias table), and its 3px left rule stays because it marks a state (DR-9).
- **Home.** Task-only.

### DS-TASK-8 Task trail

- **Purpose.** Things that happened on one task, newest first: the history of transitions, the All activity tab, and the run's operational log.
- **Anatomy.** `.sbact` (grid) > `.sbact__row` (grid, gap .1rem, padding 7.2 0, bottom 1px `--border`) > `.sbact__meta` ("<when> · <kind> · <who>", Chivo Mono 12 `--text-muted`) + `.sbact__t` text (Sans .85rem / 1.4).
- **Variants.** `history` (DT-22/23, TT-05: transitions only; folded in the panel with "Show all N changes", open on the page); `activity` (DT-20: comments, notes, done steps, time; a client row `is-client` carries a 2px `--accent` left rule and 12 inset); `ops` (TA-06: "JOB-01 · done · <time> · <person>" + title, failure, waiting on).
- **States.** Folded / open; empty sentence (DS-PRIM-28 `--inline`).
- **Styling.** As anatomy. Text .85rem is 13.6: snaps to DS-TOK-117 (14) or DS-TOK-120 (13); propose DS-TOK-120.
- **Shots.** History (panel): (screenshot, kept private) (screenshot, kept private) · Ops (page): annotated S6 d · Open history (page): annotated S5 c
- **Construction.** `sbActivity` `ui.js:5087-5147`, `taskHistory` `ui.js:5148-5208`, `historyStrip` `ui.js:5209-5242`; `opsBody` `taskpage-agent.js:354-393`; CSS `app.css:3833-3845`.
- **Usages.** DT-20, DT-22, DT-23, TT-05, TA-06.
- **Drift.** It is the fifth ledger COMPOSITES found (DS-COMP-14 construction note).
- **Home.** Folded (consolidation, 26 September 2026): alias of DS-COMP-14, variant `trail` (`CATALOGUE.md` alias table). This entry stays as the variant's spec.

### DS-TASK-9 Token tracked

- **Purpose.** The agent's token allowance against what was spent, and one row per run.
- **Anatomy.** Section head ("TOKEN TRACKED" · "122k of 120k tokens") > `.tokpanel` (grid gap 8) > `.tokpanel__est` (Allowance, "computed by <model> from N skills") > Composed from DS-PRIM-11 `--outline` chips > DS-PRIM-23 time track (`.tt__bar`, over `--danger`) > `.toksplit` Spent (in / out, over in `--danger`) > `.tokruns` > `.tokrun` rows (DS-PRIM-14 model dot by outcome, model id mono, in / out, time, duration, skill chips).
- **Variants.** `tracked`; `none` (`.tokempty`: a person's task, estimated in time).
- **States.** Under / over allowance.
- **Styling.** Run rows flex wrap, gap 4 × 8.8, padding 6 0, top 1px `--border` (none on the first). Model id Chivo Mono 12 `--text-2`, never truncated and never uppercased. "computed by" 11 `--text-muted`.
- **Shots.** Tracked: (screenshot, kept private) (screenshot, kept private) · None: (screenshot, kept private)
- **Construction.** `tokenTrack` `ui.js:4217-4282`; CSS `app.css:9478-9531`.
- **Usages.** DA-09, TA-12.
- **Drift.** The run dots are a ruled carve-out (§115 item 5): keep.
- **Home.** Task-only.

### DS-TASK-10 Rank calculation

- **Purpose.** Show how the rank is derived, so it is never a number nobody can trace.
- **Anatomy.** `p.mcalc`: "impact **7** × confidence **9** × ease **8** · priority stage ×w · open N weeks ×b = **504**" + `.mcalc__src` ("derived", or "inherited from …").
- **Variants.** `line` (TP-09, under the strip, pulled up by a negative top margin); `section` (DA-10, in its own ruled section with head "RANK CALCULATION · #N"); `none` (`.mcalc--none`, italic Sans 13: "Not scored …").
- **Styling.** 12 / 1.5 `--text-muted`, tabular figures, numbers 600 `--text-1` (DS-TOK-122 `--type-caption`; the 600 numbers are faux-bold-safe, Sans loads 600).
- **Shots.** Section: (screenshot, kept private) (screenshot, kept private)
- **Construction.** `sbCalc` `ui.js:4514-4553`; CSS `app.css:11112-11124`.
- **Usages.** DA-10, TP-09.
- **Drift.** The negative top margin couples it to the strip above: build it as the strip's foot instead.
- **Home.** Task-only.

### DS-TASK-11 Task record header and facts band

- **Purpose.** The task at reading scale: where it lives, its id and state, its name, where its run is, then its facts.
- **Anatomy.** `.tpr` (grid, gap 12, margin-bottom 16) > `.tpr__crumb` (DS-PRIM-26 "Projects →", "› <board> › <category>", DS-PRIM-25 id, DS-PRIM-15 state, DS-PRIM-2 copy) > `h2.tpr__title` > run line (`.card__sub`). Then `.tpr__facts` > DS-TASK-1 read-only > DS-TASK-10 `line` > DS-COMP-26 read-only form > DS-PRIM-11 tag chips.
- **Variants.** One; the run line has three shapes (running, finished, no agent).
- **States.** Copy: `copied` for 1.2 s (a check). Complete: state word in `--success` (build), the mockup prints the run tone (D-06).
- **Styling.** Title Funnel Display 44 / tight, 600, `--text`, wraps anywhere (DS-TOK-107 `--type-display` is 500: drift, snap). Crumb Sans 14 `--text-muted`, gap 8. Facts form 5 columns at 1480, 2 at 900, 1 at 390.
- **Shots.**

  | Part | Width | Light | Dark |
  |---|---|---|---|
  | header | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | header | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | header, complete (mockup blue) | 1480 | (screenshot, kept private) | – |
  | facts band | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | facts band | 900 and 390 | the narrow page layouts in section 2.3 | same |

- **Construction.** `found` `taskpage.js:85-135`, `recordHeaderBits` `taskpage-team.js:247-286`, `fieldRows` `taskpage-team.js:345-444`; copy `taskpage.js:175-188`; CSS `app.css:12660-12670`.
- **Usages.** TP-01 to TP-11.
- **Drift.** `.tpr__strip` and `.tpr__cell` (`app.css:12665-12669`) are an older strip with no call site (only `tests/cssgate.html`): drop. The page carries two headings for one name (the topbar h1 and the `h2.tpr__title`): both kept, as drawn (DR-63, answered: DIRECTION, "built as it is in the mockup").
- **Home.** Task-only; it is the record-page header a later record page (a client, a document) may reuse.

### DS-TASK-12 Execution graph

> **Likely replaced; tied to the harness decision.** The owner, 26 September 2026: the whole graph may be switched for LangGraph or a similar visual agent interface. The visual depends on the harness chosen (decisions, "Harness adoption"; agent runtime); if LangGraph or Langflow is adopted, its own workflow view may replace this component. Catalogued as drawn for reference; no connector variants or other investment until the harness is decided.

- **Purpose.** The run's jobs as a read-only derived map: columns by depth, connectors by dependency, one node selected into the inspector.
- **Anatomy.** `.tg` > `.tg__bar` (study label, DS-PRIM-10 facets, `.tg__legend`: "Dependency" `--accent`, "Blocked" dashed `--warning`, "Derived layout · not editable") > scroll box (760 at 1480) > canvas: `.tg__stage` labels (DS-PRIM-25 + a 1px `--border` hairline), `svg.tg__edges` (`.tg__edge` 2px `--accent`, `--wait` dashed 5 4 `--warning`, `.tg__join` r 3.5), DS-TASK-13 nodes > DS-TASK-14 inspector > orphan note and empty states (DS-PRIM-28 `--inline`).
- **Variants.** `canvas` (above 900: geometry node 208 × 136, column gap 48, row gap 28, pad-x 16, pad-top 12, stage row 16, pad-bottom 28); `list` (≤900: nodes full width, no SVG, no stage labels, a dependency sentence under each card).
- **States.** Route (Rail drawn, for reference only: R63, likely replaced, no connector work); a node selected; no run; no layout.
- **Styling.** Three connector colours only: `--accent`, dashed `--warning`, and a grid quieter than `--border`.
- **Shots.** Bar: (screenshot, kept private) (screenshot, kept private) · List at 900 (bar to the third node): (screenshot, kept private) (screenshot, kept private) · Canvas: see the S7 annotated shot.
- **Construction.** `mountTaskGraph` `taskgraph.js:559-672`, `routeBar` `:526-541`, `stageLabels` `:542-558`, `edgesSvg` `:347-372`, routes `:192-316`, `edgeBlocked` `:129-131`; self-mount `:710-727`; CSS `app.css:12448-12593` (≤900 at `:12580`).
- **Usages.** TA-02, TG-01 to TG-04, TG-06, TG-08, TG-09.
- **Drift.** Four of five route studies are temporary (§111.5): deleted at port (R63). "Not editable" is said twice (D-19). An approved gate's out-edge draws blocked (D-38). The study facets stay visible at ≤900 where there is no connector to restyle (Astra): gone with R63.
- **Home.** Task-only.

### DS-TASK-13 Graph node card

> **Likely replaced with the execution graph (DS-TASK-12); tied to the harness decision.** Not refined further (lane RECONCILE-LOOK, 27 September, against the fresh audit FA-TASKS-74 to FA-TASKS-78).

- **Purpose.** One job in the map: key, state, title, owner and what it outputs, needs, waits on or stopped at.
- **Anatomy.** `button.tg__node` > `.tg__ntop` (key, DS-PRIM-15 state) > `.tg__nt` title > `.tg__nowner` line > `.tg__nout` ("OUT / NEEDS / WAIT / STOP" in `--accent` or `--warning` + text) > dependency sentence (≤900 only).
- **Variants.** Tone: gate (left rule `--warning`), run (`--accent`), other (`--border-strong`); terminal (dashed sides, solid left).
- **States.** Default; hover (top and right `--border-strong`, ground `--surface-2`); focus-visible (2px `--accent` outline, offset 1); pressed (`aria-pressed`, top and right `--accent`); a `data-tg-note` title for layout notes (DS-PRIM-18).
- **Styling.** 208 × 136, `--surface`, 1px `--border`, 3px left rule; title Sans 13 600 (DS-TOK-121 snap); key and owner Chivo Mono (DS-TOK-124). Border colour and ground transition 120 ms `cubic-bezier(0.16, 1, 0.3, 1)` (`--ease-out`); cursor pointer. The gate node shot is its pressed look, because the inspector preselects it.
- **Shots.**

  | State | Light | Dark |
  |---|---|---|
  | default | (screenshot, kept private) | (screenshot, kept private) |
  | hover | (screenshot, kept private) | (screenshot, kept private) |
  | focus-visible | (screenshot, kept private) | (screenshot, kept private) |
  | pressed | (screenshot, kept private) | (screenshot, kept private) |
  | gate tone | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `nodeCard` `taskgraph.js:373-401`, `outputLine` `:418-438`; CSS `app.css:12492-12527`.
- **Usages.** TG-05.
- **Drift.** Focus-visible draws the node's own 2px `--accent` outline **and** the global ring (a 2px paper plus 4px `--accent` box-shadow): the double ring PRIMITIVES found on buttons. Keep one.
- **Home.** Task-only.

### DS-TASK-14 Graph inspector

> **Likely replaced with the execution graph (DS-TASK-12); tied to the harness decision.** Not refined further (lane RECONCILE-LOOK, 27 September, against the fresh audit FA-TASKS-74 to FA-TASKS-78).

- **Purpose.** Everything about the selected job, under the map.
- **Anatomy.** `.tg__insp` (grid gap 12, padding-top 16) > "<KEY> · <kind>" + DS-PRIM-15 state > `.tg__insp__t` title > for a gate, the DS-TASK-7 `.gate` card with "Binds <artefact> · <digest>" > `.tg__insp__facts` (auto-fit columns, min 15rem) of `.sout__row` facts: Needs, Inputs, Output, Ran, Owner, Evidence, Stopped / Refused, Waiting on, Attempt, Layout, State contributed.
- **Variants.** Job; gate.
- **States.** Preselected (waiting gate, else running or blocked, else failed); nothing selected ("Nothing selected. Choose a node to see …").
- **Styling.** Title Sans 16 / snug `--text` (DS-TOK-111 is Display: snap to DS-TOK-119, flag). Facts keys `tf__k` (DS-TOK-126), values Sans 13.
- **Shots.** (screenshot, kept private) (screenshot, kept private)
- **Construction.** `inspector` `taskgraph.js:439-499`, `gateStale` `:500-517`; CSS `app.css:12568-12575`.
- **Usages.** TG-07.
- **Drift.** It describes a node that may sit outside the scroll box (D-15); the unbroken `sha256:` digest overflows at 390 (D-16).
- **Home.** Task-only.

### DS-TASK-15 Agent perspective grid

- **Purpose.** The page's Agent tab: the run in a wide main column, what it was given and allowed in a narrow side column.
- **Anatomy.** `.tpg` > `.tpg__main` (grid gap 24; sections are DS-COMP-22 ruled sections, padding 24) + `.tpg__side` (grid gap 16; sections have a top rule and padding 8 0 12).
- **Variants.** Two columns (≥1279: `minmax(0, 1fr) 21rem`, gap 24); stacked (below 1279, side under main).
- **Styling.** At 1480 main 808, side 336.
- **Shots.** The annotated S6 pieces in section 2.3 (a to d: main; e to g: side) and the narrow layouts there. A whole-column crop is over 40 KB even at scale 0.5, so it is not kept.
- **Construction.** `taskPageAgent` `taskpage-agent.js:409-494`; CSS `app.css:12691-12697`.
- **Usages.** S6 as a whole.
- **Drift.** At 1480 the side column covers the graph's later columns (D-15).
- **Home.** Folded (consolidation, 26 September 2026): alias of DS-COMP-37 page layouts, variant `agent perspective` (`CATALOGUE.md` alias table). This entry stays as the variant's spec.

---

## 5. Defects not to copy

Every task defect in `TASKS.md` "Dead doors and inconsistencies", `TASKS-CROSSCHECK.md` section 3 and `TICKET-PLAN.md` section 5, merged where they name the same fault.

| # | What the mockup does | Build instead | Source |
|---|---|---|---|
| 1 | Every new task defaults its client to one fixed client (the mockup's sample, Meridian Dental) | The client from the page's scope, or empty | D-01; X6 |
| 2 | Create task writes to the personal to-do list, so it never reaches a board, the deck or its page | Create writes a real task | D-02; X7 |
| 3 | Create is silently discarded if the Projects list has never opened | Create always lands | D-26; XC D2; X7 |
| 4 | Create drops tags, project, stage, agent brief and an AI owner; priority reads a removed control | Every field chosen on the draft is kept | D-27; XC D3; X7 |
| 5 | Roll back is drawn and has no handler | Drawn unavailable with the not-connected treatment until the executor can restore (R78) | D-03; XC D12; X9 |
| 6 | The reaction chip invites a click in its title and does nothing | Display only, no instruction in its title, no pointer; or drawn unavailable (R56) | D-04 |
| 7 | Client and Project selects offer one option each | Real options from the stores | D-05 |
| 8 | Complete is toned as a running state on the page (tests the word "Done") | Complete reads done, `--success` | D-06; XC D19; X20 |
| 9 | Panel and page differ: conversation default (Client vs Internal), Agent count rule, a Team count only in the panel | Internal on both (R41); one count rule on both | D-07; XC D20 |
| 10 | Six inert marks on the page keep `cursor: pointer` | No pointer on anything that does not act | D-08; X45 |
| 11 | Description is mono in the panel, sans on the page | Sans everywhere; mono only for the Agent brief (R60) | D-09 |
| 12 | A time note opens only by click; the composer does not send on Enter | Enter opens the note and sends the message | D-10; X17 |
| 13 | Replies render and nothing can write one | A one-level Reply control and composer (R42) | D-11 |
| 14 | The briefcase goes to the client-portal board from an agency panel | The agency board, from the one route table | D-12; X3 |
| 15 | Ids print in capitals, so the missing page misquotes what was typed | Ids print as typed and stored | D-14; X20 |
| 16 | The graph preselects a gate outside its scroll box at 1480 | Scroll the preselected node into view | D-15; X33 |
| 17 | The page's Agent tab overflows 222px at 390 (an unbroken digest) | Wrap the digest; no horizontal overflow at 390 | D-16; XC D18; X19 |
| 18 | At 390 the gate step's note overlaps its text, and says "above" for something on another tab | The note wraps to its own line; the words name the Agent tab | D-17; X19 |
| 19 | "Checks passed N of N" counts one thing twice | Two real counts, both derived | D-18; X12 |
| 20 | "Derived layout · not editable" appears twice on the map | Say it once | D-19; X33 |
| 21 | The PAUSED chip stretches to the full row | Chip at its content width | D-20 |
| 22 | A board row reads "AI" while the panel names a person for the same task | One assignee reading everywhere | D-21; X11 |
| 23 | An agent task's Status offers only the run ladder | Ladder plus On hold (R43) | D-22 |
| 24 | Empty states say "project" on a task surface | Say "task" | D-23 |
| 25 | The page's Back button throws `__snap is not defined` | Shell fix (SHELL lane) | D-24 |
| 26 | The snapshot icon wraps onto its own line | Icon inline with its text | D-25 |
| 27 | Client and person rows open a thin copy (`pa-<id>`): no description, subtasks, brief or page door; edits never reach the task | The row opens the task itself | D-28; XC D1; X48 |
| 28 | Assign to AI saves, then reopens as Unassigned | It reopens as AI | D-29; XC D4; X11 |
| 29 | Editing Category rewrites the machine-set scope stamp | Lane from the grant, read-only (R76) | D-30; XC D5; X50 |
| 30 | Ticking a subtask leaves the Team count and Whose move stale | Counts and derived facts follow every edit | D-31; XC D16; X51 |
| 31 | Escape in a select, the date picker, a message edit or a time-note edit closes the whole panel; select arrows choose instead of moving | A field that handles Escape stops it; arrows move | D-32; XC D17; X15 |
| 32 | Closing the panel or opening another task with the timer running discards the elapsed time | Per R77 (decided): stop the timer and log the elapsed time as a time entry | D-33; XC Q5; X52 |
| 33 | Two clocks: quick picks use the real date, due words the estate's; the viewer is a fixed name | One estate clock; the viewer is the signed-in person | D-34; XC D11; X13 |
| 34 | Replies under any message after a thread's first are deleted at load | Replies survive load | D-35; XC D8; X47 |
| 35 | "Reply to the client" adds a top-level comment and never answers; the Client thread is not in time order | A reply answers and clears the owed signal (R42); one time order | D-36; XC D9, D10; X47 |
| 36 | Three completion paths do different things; unfinished steps are retired only at load; status and board approval never touch the run, jobs or gate (status can read Live while the run waits at its gate) | One completion transition; the task state follows the run | D-37; XC D6, D7; X49 |
| 37 | Copy-address shows its tick when the copy failed | Tick only on success | D-38; XC D13; X51 |
| 38 | An approved gate still draws its out-edge as blocked | Approved counts as done for the edge | D-38; XC D14; X51 |
| 39 | A connector-style address loses its style on reload (`&route=curve` loads Rail) | Moot once R63 keeps one style | XC D15 |
| 40 | Links and stored addresses use the old `/agency/task/?task=` source path | Canonical addresses from one route table (TASKS Q1) | X3 |
| 41 | Numbers typed beside derived ones | Every figure derives from its rows | X12 (task row: D-18) |
| 42 | The gate's buttons change nothing (demonstration) | The real decide path (R44) | TASKS S3 DA-07; R44 |
| 43 | `.sb` still carries its old fixed-drawer rule (`position: fixed`, z 72, slide) although the task now mounts in the dock | Build the body as dock-panel content only; no second drawer | `app.css:3769-3775` vs `ui.js:6262-6285` (new, this lane) |
| 44 | The dock tab strip sits below the screen at 900 and less | A visible strip at rest and the Task panel as a sheet (R33) | X1 (task surfaces at 900, 390) |

---

## 6. Duplicates and hand-ons (for CONSOLIDATE)

All six were resolved at consolidation and at build-ready (`CATALOGUE.md`, "Alias table"): 1, DS-COMP-21 is an alias of DS-SIDE-8; 2, the `.cmtabs` usage moved from DS-PRIM-10 to DS-COMP-23; 3, DS-COMP-25 was corrected; 4, `.gate` lives in DS-TASK-7; 5, the folds were made (DS-TASK-2, DS-TASK-8 and DS-TASK-15 are aliases, DS-TASK-5's toggle is DS-COMP-12) and DS-COMP-13 carries the `gate step` and `archived` states; 6, the type exceptions are ruled (TICKET-PLAN R53, DR-6). The list below is kept as the record.

1. **Panel head, twice.** DS-SIDE-8 and DS-COMP-21 both specify the dock panel head, with the same measurements. This file points DP-01 to DS-SIDE-8 (the dock is the reference, NEW-298) and uses DS-COMP-21's slot table for the task's controls. Merge to one id.
2. **The Team | Agent switch, twice.** PRIMITIVES lists `.cmtabs` under DS-PRIM-10 (segmented control) and COMPOSITES under DS-COMP-23 (panel tab set). This file uses DS-COMP-23. Remove the DS-PRIM-10 usage.
3. **`.sb` as a drawer.** DS-COMP-25 records the task sideboard as a fixed right drawer. It is not one: since 28 July it mounts inside the dock's Task panel (`ui.js:6262-6285`), and the fixed rule at `app.css:3769-3775` is dead. Remove `sideboard` from DS-COMP-25's "what exists".
4. **`.gate`.** DS-COMP-5 drops `.gate` as a strip dialect; DS-TASK-7 uses it as the gate card. Settled: one home, DS-TASK-7, with the 3px state rule (DR-9).
5. **Proposed folds.** DS-TASK-2 into DS-COMP-22 (`tag field`); DS-TASK-5's toggle into DS-COMP-12; DS-TASK-8 into DS-COMP-14 (`trail`); DS-TASK-15 into DS-COMP-37 or a page-layout entry; DS-COMP-13 gains the task states `gate step` and `archived`.
6. **Type.** Six task styles have no exact canonical style: the name 16.8 Display, the title 44 at 600, the hero's mono 20 numbers, the strip label's .04em tracking, the trail's 13.6 text, the inspector title in Sans 16. Each is snapped above; the mono numbers are a named exception (DR-6).

## 7. Known gaps

- **Date picker grid.** PRIMITIVES handed the calendar grid to COMPOSITES, and COMPOSITES does not specify it. The Astra cross-check (27 September) gave the grid an id, DS-COMP-38, and DP-20b now points there. No crop of the open picker was taken.
- **Open select menus** in the panel (DP-18 to DP-25) were not shot; DS-PRIM-19 carries the option menu.
- **R77 and R42 are drawn as compositions of existing components,** not as shots: neither exists in the mockup. The R77 app-strip timer is SHELL SH-17 (DS-COMP-1).
- **Dark variants** of two single-state crops (the complete strip and the no-token panel) were taken in light only; every token re-resolves in dark and nothing else changes.
- **The 901 to 1279 dock tier** is described from the source and Astra's review, not shot.
- **Hover-only states on parent rules** (the time entry × and message tools appear on the row's hover) cannot be forced by `crop.mjs`. Their looks are read from `app.css:5295-5296` and `:6546-6548`.
