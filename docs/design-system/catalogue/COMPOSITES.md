<!-- Public edition, generated from the private design-system source by ticket C82's build and checked by the real-names check before it crossed. Do not edit it here; the source changes and the copy is run again. Screenshots and review records stay private, so they are not linked. -->

# Composite components

This is the canonical catalogue of the Ops Astro composite components: the parts that are built from primitives and repeat across pages. It answers to `docs/design-system/DIRECTION.md`. The owner's words there win over anything here.

Round: design-system pass, wave 1, lane COMPOSITES, 26 September 2026. It is plan and document only. Nothing in either repository was built or changed.

## How to read this file

- **Ids** are `DS-COMP-<n>`. They are numbered from 1 and never reused. Page inventories (`docs/mockup-inventory/*.md`) cite these ids; the ticket plan will cite them too.
- **Construction** cites the mockup (`dashboard-mockups`) as `file:line`. Short forms: `app.css` is `assets/app.css`, `ui.js` is `assets/ui.js`, `portal.js` is `assets/portal.js`, `hub-ds/` is `assets/hub-ds/`. The mockup was never cleaned up and has bugs. The code is evidence of what was meant, not a pattern to copy.
- **Styling** comes from `crop.mjs` measurements, with token names from its matcher. Where tokens alias to one colour, the canonical name is given first (for example `--surface`, which is #ffffff light and #0f0f12 dark). Spacing tokens: `--s-2` 8px, `--s-3` 12px, `--s-4` 16px, `--s-5` 24px, `--s-6` 32px. Motion tokens: `--ease-out` is `cubic-bezier(0.16, 1, 0.3, 1)`; `--dur-2` is 420ms.
- **Shots** live in `../shots/comp/<id>/`, named `<variant>-<state>-<width>-<theme>.png`. Every shot is 40 KB or less. A shot marked scale 0.5 to 0.85 was shrunk to fit the cap. The default width is 1480. A component that changes at narrower widths also has 900 and 390.
- **Usages** list inventory element ids by page file. Two inventories reuse prefixes: WORKBENCH's shared components are `SH-01` to `SH-34`, written here as `WB SH-nn` so they do not collide with SHELL's `SH-n`; TASKS' `TM-*` clash with DOCK's Team `TM-*`, so DOCK's are written `DK TM-n`.
- **Drift** is each other way the mockup draws the same thing. Each drift says keep (as a named variant) or drop. Where a drift might have been intended, the lane raised a ruling. Every one is now decided and written into its entry by `DR` id (collected, with the ruling, in "Rulings, decided" at the end).
- **Primitives** inside a composite (buttons DS-PRIM-1, icon buttons DS-PRIM-2, chips DS-PRIM-11, inputs DS-PRIM-3 to DS-PRIM-6, tooltips DS-PRIM-18, menus DS-PRIM-19, tables DS-PRIM-20, empty states DS-PRIM-28, the meter DS-PRIM-23, the banner itself DS-PRIM-22) belong to `PRIMITIVES.md`. They are named here but not specified. Consolidation (26 September 2026) swapped the names for DS-PRIM ids and turned duplicate entries into pointers; `../CATALOGUE.md` is the index and holds the alias table.

## How to read behaviour in this file

DIRECTION.md point 6: the look is canonical, in every state, token, size, motion and shot recorded here. What a composite does in the mockup shows a capability Ops Astro must really have. The build makes it real and tracked (the event or record it creates), listed in [`PLACEHOLDERS.md`](../PLACEHOLDERS.md) under the component's catalogue id. The mockup's handlers, stored keys and demo-only states are evidence of intent, not the thing to build. Bugs are never copied. Until a capability is real, its control is drawn disabled with its reason (TICKET-PLAN R56), never live and dead. Behaviour the owner stated as law in their own words (WIRING.md) is specified exactly.

## Index

| Id | Component | Group |
|---|---|---|
| DS-COMP-1 | App strip | Chrome |
| DS-COMP-2 | Tab row and tab mark | Chrome |
| DS-COMP-3 | Page header | Chrome |
| DS-COMP-4 | Section head | Page structure |
| DS-COMP-5 | Tip and alert strips (placement) | Page structure |
| DS-COMP-6 | Stat row | Cards |
| DS-COMP-7 | Card (content and list card) | Cards |
| DS-COMP-8 | Door card | Cards |
| DS-COMP-9 | Verdict strip | Cards |
| DS-COMP-10 | Finding card | Cards |
| DS-COMP-11 | Recommendation card | Cards |
| DS-COMP-12 | Disclosure layer | Page structure |
| DS-COMP-13 | List row | Lists |
| DS-COMP-14 | Feed and ledger | Lists |
| DS-COMP-15 | Message thread and composer | Conversation |
| DS-COMP-16 | Filter and command bar | Boards |
| DS-COMP-17 | Board table (column head, group row, row) | Boards |
| DS-COMP-18 | Board card | Boards |
| DS-COMP-19 | Stage strip | Boards |
| DS-COMP-20 | Roadmap columns | Boards |
| DS-COMP-21 | Dock panel header (alias of DS-SIDE-8) | Dock interiors |
| DS-COMP-22 | Dock panel body parts | Dock interiors |
| DS-COMP-23 | Panel tab set | Dock interiors |
| DS-COMP-24 | Popover menu (alias of DS-PRIM-19) | Overlays |
| DS-COMP-25 | Modal, sheet and drawer | Overlays |
| DS-COMP-26 | Form layout | Forms |
| DS-COMP-27 | Axis chart (line, column) | Charts |
| DS-COMP-28 | Radial chart (donut, gauge, score dial) | Charts |
| DS-COMP-29 | Inline chart (sparkline, bar list, band track) | Charts |
| DS-COMP-30 | Project timeline (Gantt) | Charts |
| DS-COMP-31 | Hero | Page structure |
| DS-COMP-32 | Meeting card | Cards |
| DS-COMP-33 | Source rows | Lists |
| DS-COMP-34 | Journey map | Page structure |
| DS-COMP-35 | Client face deltas | Cross-cutting |
| DS-COMP-36 | Placeholder page | Page patterns |
| DS-COMP-37 | Report layouts | Page patterns |

---

## Chrome

### DS-COMP-1 App strip

- **Purpose.** The dark strip across the top of every page: history, the client identity on client pages, global search, presence, the face switch and the timer. It tells the reader which face they are on (agency or client).
- **Anatomy.** `header.appbar` > back and forward (`.appbar__nav`) · client identity (`.clienthdr__mark`, `__name`, `__tag`; client pages only) · search box (`.appbar__search` with a `⌘K` keycap) · right group `.appbar__r`: presence avatars (`.viewers`), face switch (`#viewSwitch.segmented`), start timer (`.appbar__timer`).
- **Variants kept.**
  - `hub`: no identity block; the search box takes the free width.
  - `client-agency`: identity block with the tag "AGENCY VIEW"; the mark is filled `--accent`.
  - `client-face`: the strip turns `--client-brand` teal; tag "CLIENT PORTAL"; presence and the timer are hidden; the mark is `app-ink 20%`.
- **States.** Nav and timer hover: `app-ink 10%` fill, full app-ink. Face switch pressed: app-ink fill, app-chrome text. No hover on the face switch (SHELL I8). Sticky above 900.
- **Styling.**

  | Part | Light | Dark |
  |---|---|---|
  | Ground `--app-chrome` (= `--face-chrome`) | #0a0a0d; client face `--client-brand` oklch(0.33 0.058 192) | #222226 (lifted off the void); client face teal |
  | Ink `--app-ink` (= `--face-chrome-ink`) | #f8f8f8 | #f8f8f8 |
  | Box | 45 tall, flex, padding 6.4 16, gap 16 (`--s-4`); Sans 13 | same |
  | Search | height 32, fill `app-ink 7%`, border 1px `app-ink 12%`, text `app-ink 50%`, padding 4.8 9.6 | same |
  | Nav buttons | 26×26, glyph 12.8, `app-ink 55%` | same |
  | Timer | 101×30, 1px `app-ink 22%`, padding 4 9.6 | same |
  | Client identity | Mark 22×22, initial 12 (`.75rem`) weight 600; name Funnel Display 14.4 (`.9rem`) 600, tracking tight, no wrap, ellipsis; tag Chivo Mono sm 400 upper, `--tracking-label`, `app-ink 46%` (`app.css:188`, `:2703-2713`, `:3091`) | same |
  | Presence | 22 circles overlapping by 1.6 (`-.1rem`); initials `.44rem` (7px); ring `app-ink 30%`, fill `app-ink 8%`, ink `app-ink 70%`; the person on this page (`is-here`) has a full `app-ink` ring and ink (`app.css:2743-2751`) | same |
  | Face switch | Segmented pair 137×32 (two 68×30 buttons), 1px `app-ink 22%`; Chivo Mono 12 300 upper, idle `app-ink 60%`, no fill; pressed `app-ink` fill with `app-chrome` text; no hover change (`app.css:2734-2737`) | same |

  At 900: padding 6.4 12, gap 12, the search and the identity tag are hidden. At 640: the nav pair, presence and the timer label are hidden (the timer keeps its icon). No radius, no shadow.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | hub | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | hub | default | 900 | (screenshot, kept private) | (screenshot, kept private) |
  | hub | default | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | client-agency | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | client-agency | default | 900 | (screenshot, kept private) | (screenshot, kept private) |
  | client-agency | default | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | client-face | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | client-face | default | 390 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** Built in JS by `buildChrome()` `portal.js:1096-1159`; presence from `wireViewers()` `portal.js:563-590`. CSS `app.css:2682-2751` (tokens 2682-2688, strip 2691-2695, nav 2697-2702, identity 2703-2714, search 2715-2725, right group 2726, timer 2727-2733, face switch dress 2735-2737), sticky `app.css:2768-2771`, 900 `app.css:2790-2795`, 640 `app.css:2796-2800`. It starts at the rail's edge, not the window's (`portal.js:1103-1107`).
- **Usages.**
  - SHELL: SH-10 to SH-17, SH-33.
  - PORTAL: PF-06, PF-07, PO-I26.
  - AGENCY: the face switch written into the header meta on Portfolio and Executive (see drift).
  - Every other page wears it without an id.
- **Drift.**
  - `#viewSwitch` is written into each page's `.topbar__meta` (`agency/portfolio/index.html:107`, `agency/executive/index.html:96`) and moved into the strip by `portal.js:1089,1143`. Drop the page copy: the strip owns it.
- **Defects not to copy.** Search is unwired (`data-unwired`, no listener). The timer is unwired. Both are placeholders (`PLACEHOLDERS.md`, DS-COMP-1): search is built real; the strip timer ships disabled on the agency side (TICKET-PLAN R29), and TICKET-PLAN R77 decided (closing the task panel, or opening another task, stops the timer and logs the time; `PLACEHOLDERS.md`, "Behaviour decided"); the timer is built in the Tasks phase, outside the T1 demo. Forward has no disabled look when there is no forward entry. The face switch has no hover rule (I8).

### DS-COMP-2 Tab row and tab mark

- **Purpose.** The section's sub-pages as a row of tabs under the strip, with a sliding accent underline that carries across page loads.
- **Anatomy.** `nav.tabbar[aria-label=Sections]` > `a.tabbar__t` × n > label; `span.tabmark` (the underline).
- **Variants kept.** One. Door marks (`.door__mark`) may sit inside a tab label; they belong to PRIMITIVES.
- **States.** Default `--text-2`; hover `--text`; current (`aria-current=page`, `.is-on`) `--text` weight 500; focus-visible uses the global ring (2px `--bg` then 2px `--accent`). The mark slides over `--dur-2` (420ms) `--ease-out` and snaps on first placement (`.is-placing`); reduced motion turns the slide off.
- **Styling.**

  | Part | Light | Dark |
  |---|---|---|
  | Row | 43 tall, `--bg` #ffffff, padding 0 32 (`--s-6`), gap 32, 1px bottom `--border` #000 12% | `--bg` #0a0a0d, `--border` #f5f5f5 10% |
  | Tab | Sans 14/21.7 400, padding 10.4 0 8.4, `--text-2` #6b635d, 2px transparent bottom | `--text-2` #f8f8f8 72% |
  | Mark | 2px `--accent` #745cee | same |

  At 390 the row scrolls sideways with no visible scrollbar and no fade.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | row | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | row | default | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | tab | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | tab | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | tab | focus-visible | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `buildTabs()` `portal.js:1278-1350` clones the rail's sub-items into the row; `placeTabMark()` `portal.js:1208-1275` writes the departing geometry to sessionStorage `aa-tabmark-from`; that key is how the mockup carries the slide across page loads, and the build keeps the slide, not the key. CSS `app.css:2807-2819` (row, tab, hover, `.is-on`), overrides `app.css:2847` and `2857-2858`, mark `app.css:2867-2881`, bold-ghost rule `app.css:3133-3138`.
- **Usages.**
  - SHELL: SH-18, SH-19, SH-32.
  - WORKBENCH: WB SH-01.
  - BOARDS: the tab rows of `/clients/` (§6.1) and the client board (§8).
  - PORTAL: PP-01.
  - AGENCY: every designed page except the Activation map, which has no tab row.
- **Drift.**
  - `.tabbar` is declared three times (`app.css:2807`, `2847`, `2857`): gap `--s-5` then `--s-6`; tab size .9375rem then .875rem. Keep the last (gap 32, 14px); drop the others.
  - A legacy `.tabs button[aria-selected]` set (`app.css:130-137`: .875rem, 500, `--text-muted`, accent bottom) is still used by the client board's tab row. Drop it; fold into this component.
  - The Hub `.tabs/.tab[data-active]` in `hub-ds/primitives.css:105-148` (brand underline, pill variant) is unused by pages. Drop.
  - PORTAL PP-01 records the mark as a 2px `--text` underline. The CSS draws `--accent`. The CSS is right.
- **Defects not to copy.** The row overflows at narrow widths with no scroll affordance (WORKBENCH D27, CLIENT CL-I12). **Build (TICKET-PLAN R62):** the one row scrolls sideways, with a fade and an arrow button at whichever edge has more tabs.

### DS-COMP-3 Page header

- **Purpose.** Names the page and holds its page-level controls: the title on the left; on the right a meta slot with the freshness marker, a placeholder chip, or page controls (period, draft, Share, Ask us).
- **Anatomy.** `header.topbar` > `.topbar__title` > `h1.t-title` · `.topbar__meta` > [freshness marker `button.marker.fresh`] [page controls] · at ≤900 a hamburger `button.navtoggle` is put first (`order:-1`; the rail drawer itself is lane SIDEBAR).
- **Variants kept.**
  - `plain`: title plus meta (hub pages).
  - `client`: `.topbar__title--client` > `.topbar__section`, used by designed client pages.
  - `placeholder`: the meta slot holds the outline chip "PLACEHOLDER PAGE".
  - `report`: the meta slot holds report controls (`.repctl`: week picker, draft state, Share).
- **States.** None of its own. At 900 the meta wraps under the title (105 tall on Portfolio); at 390 it stacks (148 tall on Portfolio, 190 on `/projects/`).
- **Styling.**

  | Part | Light | Dark |
  |---|---|---|
  | Box | flex, space-between, padding 12 56 12 32 (≥901; 12 32 below), gap 16, min meta height 34, 1px bottom `--border` | same, `--border` dark |
  | Ground | `--bg` #ffffff | `--bg` #0a0a0d |
  | Title | Funnel Display 24/27.6 500, tracking −.01em (DS-T14), `--text` | `--text` #f8f8f8 |
  | Freshness marker | Mono 10.88 300 UPPER, 1px border, padding 4 8, `--text-muted`, refresh icon | same |
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | plain-with-controls | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | plain-with-controls | default | 900 | (screenshot, kept private) | (screenshot, kept private) |
  | plain-with-controls | default | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | client | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | placeholder | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** Static HTML in each page (for example `route-home/index.html:31-39`); there is no builder. CSS `.topbar` `app.css:208-213` and again `app.css:2851` (padding-block `--s-3`, min-height 2.9rem); title `app.css:2893`; client variant `app.css:192-196`, line-height `app.css:3123`; nowrap above 900 `app.css:3107-3117`; 900 `app.css:668-669`; 640 `app.css:202-204`. Freshness marker: `freshness()` `ui.js:863-887`, CSS `.fresh` `app.css:2485-2486`. Report controls: `reportControls()` `ui.js:3990`, `.repctl` `app.css:3653-3674`, `app.css:3712-3758`.
- **Usages.**
  - SHELL: SH-20, SH-22, SH-23, SH-40.
  - AGENCY: AG-K1; AG-P1 to P4; AG-E1 to E3; AG-C1 to C3; AG-S1 to S3; AG-A1 to A3.
  - BOARDS: P-01, P-05 to P-08 (P-02 to P-04 are the command bar in the header, DS-COMP-16); C-08; M-06, M-07.
  - CLIENT: WK-01 to WK-06; MO-01, MO-14; TR-01; DSY-01; the Account header (§12).
  - WORKBENCH: WB SH-02 to SH-05.
  - PORTAL: PH-01, PW-01, PM-01, PT-01, PP-02, PP-03, PG-01, PLB-01, PLB-02, PLV-01, PLD-01, PLD-02, PLK-01, PAC-01, PC-01, PC-02, PB-01, PAI-01.
- **Drift.**
  - Two title insets: designed client pages sit the title at x 272, hub pages at 256 (SHELL I6). Keep one inset; `client` stays a variant only for its section label. Decided: one inset, 256 (DR-39). The fresh audit (FA-SHELL-37) found the cause, so the 272 is a defect, not a choice: the emptied identity wrapper keeps its gap after the identity moved to the app strip (`portal.js:302-320`).
  - `.topbar` padding is declared twice (`app.css:208` and `2851`). Keep the measured result.
  - Site health puts four favicons after the title (AG-S1); the workbench does the same (WB SH-02). Keep as a `title-icons` slot.
  - The client board types its stamp ("2H AGO") and has no Sync; `/projects/` derives its stamp (BOARDS D-15). Drop the typed stamp.
  - Connections (portal) has no in-page title; Book has no sync marker (PORTAL §13.1, §15.3). Built as drawn (DR-40).
- **Defects not to copy.** The freshness marker has no handler and no `data-unwired` (SHELL D6). In the product it is an indicator only, never pressed: the page stays live by push and the marker reports live, catching up, offline, source behind or frozen (DS-PRIM-25; `../research/LIVE-SYNC.md`, which supersedes WIRING §50.1 on the owner's words of 27 September). The workbench freshness text is a typed literal (`channel-workbench/index.html:386`). Ask us shows on the agency face (BOARDS D-18, M-06). The client-board search shrinks to 128px at 390 (D-16).

## Page structure

### DS-COMP-4 Section head

- **Purpose.** Opens a numbered section of a page: an index and an optional right-hand marker on a top rule, then the section title, then an optional tip.
- **Anatomy.** `.sec__meta` (top rule) > `.marker.u-tag` index ("001") · optional right marker in `--text-muted` or a status chip; then `h2.sec__head`; then optional `.banner--info.sectip` (DS-COMP-5).
- **Variants kept.**
  - `numbered`: index plus title (the default).
  - `alert index`: the index slot holds `!` or `?` (AG-E10, AG-E13).
  - `status right`: a status chip in place of the right marker (AG-S14, S16, S18, S21).
  - `rail label`: the small uppercase Display 13 label used as "HUB" in the rail and the placeholder page's "Route contract" parent label is a different thing: see drift.
- **States.** None.
- **Styling.**

  | Part | Light | Dark |
  |---|---|---|
  | Meta row | flex, gap 16, padding-top 12 (`--s-3`), 1px top `--rule` #000000 | `--rule` #ffffff 24% |
  | Index and right marker | Mono 300 UPPER `--fs-mono`, tracking +.02em | same |
  | Title | Funnel Display 28/30.8 500, tracking −.28px (`--fs-title`, DS-T13), `--text` | #f8f8f8 |
  | Gap to the next block | `.sec` gap 16 | same |
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | meta-row | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | meta-row | default | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | title | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `sectionHead(num, title, right, tip)` `ui.js:178-185`, tip from `sectionTip()` `ui.js:190-198`. CSS `.sec` `app.css:13`, `.sec__meta` `app.css:14-18`, `.sec__head` `app.css:19-23`, `.marker` `app.css:26-29`, `.index` `app.css:30-34`, `.sectip` `app.css:2062-2063`.
- **Usages.**
  - AGENCY: AG-K3; AG-P6, P10, P15, P21; AG-E5, E10, E13, E19, E21, E24, E29; AG-C5, C11, C21, C26, C30, C32, C37, C40, C44, C49, C55, C59; AG-S6, S9, S14, S16, S18, S21.
  - SHELL: SH-42, SH-54.
  - BOARDS: P-61.
  - CLIENT: BR-27, BR-32, BR-49, BR-54; TR-03 and the heads of TR-07, TR-08; DSY-02, DSY-10; VO-01, VO-03, VO-07; the Docs library heads 001 to 003.
  - PORTAL: PT-03, PLV-02, PLV-04, PLK-02, PLK-05.
- **Drift.**
  - The placeholder page uses a bare `.sec__head#routeHeading` with no `.sec__meta` (SH-42), and the measured head there is the small Display 13 uppercase label, not the 28px title. Drop: use `numbered`.
  - The launcher uses `.sec__meta` only (SH-54). Drop (the launcher is not a product page).
  - Weekly uses bare `u-tag` heads (WK-16, WK-18); Monthly uses a page-local `.chapter__title` at Display 36 (`monthly-report/index.html:28-33`). Keep the chapter title as a report variant (DS-COMP-37), ruled by DR-41.
  - Portal Connections uses a bare marker, "WHAT YOU HAVE CONNECTED TO US", in place of a numbered head (PORTAL §13.1). Drop.
  - The Hub `.section-title` (`hub-ds/primitives.css:190-191`) is unused. Drop.
- **Defects not to copy.** `sectionHead` ignores its fifth argument, the ask question (CLIENT CL-I11). Section order renders 012 before 009 on Connections (AG D-A21). Portal Docs numbering jumps 001 to 003 (PO-I16). **Build (TICKET-PLAN R61):** section numbers read top to bottom on each page and each face (Skill costing becomes 009; the client's Docs page no longer skips 002). PT-03 §003 has an empty right slot.

### DS-COMP-5 Tip and alert strips (placement)

- **Purpose.** Where the page-level strips sit and which one to use. The strip itself (`.banner`: 2px left rule, 12 16 padding, dismiss ×) is DS-PRIM-22 (old id DS-K9); this entry fixes its placements and the alerts list that is built from it.
- **Anatomy and placements kept.**
  - `page tip`: `.banner--info.sectip` directly under the page header, one per page, dismissable, the dismissal remembered per person (`PLACEHOLDERS.md`, DS-PRIM-22; the mockup's browser key `aa-dismiss-<path>-<hash>` is its implementation only).
  - `section tip`: the same strip under a section head (DS-COMP-4).
  - `page alert`: `.banner--bad` above the page tip or inside section 001.
  - `alerts list`: `.alerts` strip of alert rows (`alertStrip`, `alertRow`) at the top of the Brief.
  - `placeholder notice`: `.banner--info`, not dismissable (DS-COMP-36).
- **States.** Default; dismissed (removed, remembered); tips off everywhere (the Account switch; the mockup's key is `aa-tips-off`); only one tip shows per section.
- **Styling.** Left rule 2px: `--info` (tips; dark #38b6f1), `--bad` (alerts), `--warning` (plain). Padding 12 16, Sans 14, 1px `--border` on the other sides. Light and dark swap only the border and ink tokens.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | section-tip | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | alerts-list | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | page-tip | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `.banner` `app.css:598-612`; `.sectip` `app.css:2062-2063`; dismiss wiring `wireBanners` `portal.js:441-504`; `sectionTip()` `ui.js:190-198`; `alertStrip()` `ui.js:1554`, `.alerts` `app.css:7793`.
- **Usages.**
  - AGENCY: AG-K2; AG-P5, E4, C4, S5 (page tips); AG-K3 (section tip); AG-C6, C7, AG-S4 (alerts).
  - SHELL: SH-27, SH-41, SH-57.
  - CLIENT: BR-07, BR-08 (alerts list), BR-28, MO-02, TR-02, WK-19, AC-15, the DOC and FM banners.
  - WORKBENCH: WB SH-06, WB SH-23; CN-W01, OB-W01, SS-W07, SS-W08, SI-W08, GA-W01, MA-W01, MA-W04, EM-W01.
  - BOARDS: G-01, G-02, W-03, the §8.1 info banner, P-65 (mock-edit banner).
  - PORTAL: PH-02, PM-03, PP-04, PT-02, PLB-03, PLK-02, PLK-05, PLV-02, PLV-04, PG-02, PAC-02, PC-03, PB-02.
- **Drift.** Five left-rule dialects mark a strip:
  - `.banner`: 2px (keep).
  - `.hint` (AG-K13): 1px accent plus a wash (`app.css:534`). Drop into `.banner--info`.
  - `.gate` (AG-C56): not a strip. Its canonical home is the gate card DS-TASK-7 (`../TASK-PAGE.md`), which AG-C56 also uses. Its 3px rule is ruling DR-9 in `../CATALOGUE.md`.
  - `.chanflag` and `.draftgate`: 3px (`app.css:1346`, `1502`). Kept at 3px (DR-9): a 3px left rule marks a state, 2px marks a tip or a flagged card.
  - `.ccta` CTA strip: 3px accent (`app.css:1520`). Keep as DS-COMP-8's `cta strip` variant.
  - The Activation map reader: 3px in the state colour (`app.css:12782`). Part of DS-COMP-34.
  - BOARDS G-01 records the left rule as `--accent`; CSS and PORTAL say `--info`. The CSS is right.
- **Defects not to copy.** Banner sentences and counts are typed (AG D-A7). The hint's action button does nothing (AG D-A2): a placeholder, built real (`PLACEHOLDERS.md`, DS-COMP-5). A portal tip promises a work log the client cannot open (PO-I8).

## Cards

### DS-COMP-6 Stat row

- **Purpose.** A row of headline figures: label, number, optional track and foot, under a dotted rule.
- **Anatomy.** `.statrow.g<n>` > `.stat` × n > `.stat__label` (mono) · `.stat__num` (+ `.stat__suffix`, `.stat__of`) · optional `.stat__track` > `.stat__fill` · optional `.stat__foot` with a `.delta`.
- **Variants kept.** `g2` to `g6` column counts; `track` (with the accent progress track; `quiet` fill in `--text-muted`); `plain` (no track). The home hero's figures are DS-COMP-31, not this.
- **States.** None interactive. Mock values carry the pink mock mark (DS-PRIM-32, kept in demo installs by R56) and unwired ones the hatch (not ported: R56 draws them as not connected or disabled; SHELL DS-X4).
- **Styling.**

  | Part | Light | Dark |
  |---|---|---|
  | Row | grid, 1px dotted bottom `--border-strong` (#000 32%) | #fafafa 20% |
  | Cell | flex column, gap 8 (`--s-2`), padding 16 24 16 0 | same |
  | Number | Funnel Display 2.125rem (34) 500, −.03em, tabular | same ink |
  | Label | Mono 300 `--fs-mono-sm` UPPER, `--text-muted` | same token |
  | Track | 3px `--border`, fill `--accent` | same |

  At 900 the row goes to 2 columns (`app.css:673`); at 640 to 1 column with the number at 1.75rem (`app.css:676-677`).
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | statrow-g5 | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | statrow-g5 | default | 900 | (screenshot, kept private) | (screenshot, kept private) |
  | statrow-g5 | default | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | statrow-portal-track | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `kpiSm()` `ui.js:124-155` (the full `kpi()` was removed, `ui.js:79-82`). CSS `.stat` `app.css:258-277`, `.statrow` `app.css:294-295`, track and fill `app.css:311-317`, `.delta*` `app.css:319-328`.
- **Usages.**
  - SHELL: DS-K14.
  - AGENCY: AG-K9; AG-P8; AG-E9, E30; AG-C9; AG-S10, S17.
  - WORKBENCH: TL-W03, OB-W03, FM-W02, SI-W05, GA-W03, MA-W01, TS-W03, LR-W02, CL-W02, EM-W01, EM-W03, RV-W02.
  - CLIENT: BR-56, TR-05, AC-01, AC-06.
  - PORTAL: PP-05 to PP-08, PT-05.
  - BOARDS: W-04 (hidden on the client work log).
- **Drift.**
  - Grid widths vary per page (`g5`, `g4`, `g2` inside `g-3fr2`, `g6`). Keep the column count as a prop.
  - AC-06 mixes two raw `.stat` with two `kpiSm`. Drop the raw ones.
  - Three other stat implementations: the Hub bridge `hub-ds/stat.css:31-49`, `.hero__stat` `app.css:6151-6153` (DS-COMP-31), `.tph__stat` `taskrun.js:264` (task page, TASK-PAGE). Drop the Hub bridge.
  - Figures drawn as card rows with `hr.rule`, not as stats (AG-E28 Book movement); `.cread` at Sans 24 (BR-37, `app.css:6960-6965`); WK-10's hero number at Display 128. Keep WK-10 as the report hero (DS-COMP-37); drop the other two.
  - PORTAL PP-05 measured a 4px track; the CSS declares 3px (`app.css:313`).
- **Defects not to copy.** Deltas are typed (CL-W02, RV-W02). An "Enquiries" tile sits beside a card that says nothing measures enquiries (WB D29). Meta KPIs read zero beside mock delivery (WB D22). A half-empty `g2` row on Calls (WB D24). Pacing at two precisions (AG D-A17).

### DS-COMP-7 Card (content and list card)

- **Purpose.** The bordered surface that holds a block of content, a list or a chart.
- **Anatomy.** `.card` > optional `.card__head` (`.card__title`, `.card__sub`, right-side actions) > body. `card--flush` removes the padding so rows run to the edge; `.card__pad` restores it for a sub-block.
- **Variants kept.** `padded` (default); `flush` (list card); `chart` (a padded card whose body is a chart, DS-COMP-27 to 29).
- **States.** None on a content card. The 220ms border transition exists but no hover rule sets a new colour on a plain card. One marked state (added by lane RECONCILE-LOOK from FA-PORTAL-105): the **current** card in a set of choices, as the plan tier `.tier--current`: 1px `--accent` border plus a 3px inset `--accent` rule on the left, and an accent "Your plan" label, no status dot (`app.css:1580-1590`); the 3px edge is the DR-9 state weight.
- **Styling.**

  | Part | Light | Dark |
  |---|---|---|
  | Box | flex column, padding 24 (`--s-5`), gap 16 (`--s-4`), radius 0 | same |
  | Ground | `--surface` #ffffff | `--surface` #0f0f12 |
  | Border | 1px `--border` #000 12% | #f5f5f5 10% |
  | Shadow | `--shadow-sm` 0 1px 2px rgba(15,18,24,.05) | 0 1px 2px rgba(0,0,0,.45) |
  | Title | Sans .9375rem (15)/18 600 | same |
  | Sub | Sans .8125rem (13), `--text-muted` | same |
  | Motion | `border-color` 220ms `--ease-out` | same |

  At 640 `.card__head` wraps (`app.css:1709`).
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | padded | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | flush | default | 1480 | (screenshot, kept private) (scale 0.6) | (screenshot, kept private) (scale 0.6) |

- **Construction.** CSS `app.css:233-245`; grids `.grid`, `.g2` to `.g6`, `.g-2fr1`, `.g-1fr2`, `.g-3fr2` `app.css:246-254`, at 1279 `app.css:629-633`, at 640 `app.css:675`. The Hub `.card` (`hub-ds/primitives.css:152-181`) still applies underneath: it is where the shadow comes from.
- **Usages.**
  - AGENCY: AG-P12 to P14, P16, P18, P19, P24; AG-E7, E22, E25, E27, E28, E31 to E33; AG-C14, C22, C25, C27 to C29, C31, C34, C42, C43, C51, C53, C57, C60, C61; AG-S15, S17, S19, S22, S24 to S28.
  - SHELL: SH-44, SH-56.
  - CLIENT: BR-13, BR-14, BR-50; AC-08, AC-11, AC-13, AC-14; the DR-02 to DR-04 cards; the VO-03 notes card; MO-06.
  - WORKBENCH: the Connections board card, CN-W12, OB-W05, WP-W03, TS-W05, EM-W05, FM-W07, MA-W03.
  - PORTAL: PH-07, PH-16, PH-17, PT-07, PLV-05, PLV-07, PLD-03, PAC-03, PC-04, PC-11, PC-12.
  - BOARDS: C-41, C-42 (`.cbd__qg`, `.cbd__qh`).
- **Drift.**
  - `.vstrip` and `.afeed` use a 1px `--border-strong` outline where `.card` uses `--border` (`app.css:760`, `1072`). They are DS-COMP-9 and DS-COMP-14; keep their stronger outline (DR-42).
  - `.paction` pads 16 where `.card` pads 24 (`app.css:1126`). Drop.
  - `.layer` wraps cards 17px in (`app.css:854`). See DS-COMP-12.
  - The workbench Connections board card uses `--border`, not `--border`. Drop.
  - The Hub card's `--interactive` hover (accent-mix border, stronger shadow, a translate lift) reaches pages only through `a.card--interactive` on Track record. See DS-COMP-8.
- **Defects not to copy.** Two table-header dialects inside cards (AG D-A8). The measured email card sits on a pink mock ground (WB D15). With every opportunity open on Website performance (WP-W04), the page is 8,959 px wide at 1480 (7,479 px of overflow): one `.opp__items` list item carries an unbroken URL (`https://connect.facebook.net/signals/config/...`) with no `overflow-wrap`, rendered by `oppRow` (`ui.js:2515-2516`); measured 27 September, capture `WORKBENCH/website-performance--opps-open/1480-light.json`. Card bodies wrap long tokens. (Added by the Astra cross-check.)

### DS-COMP-8 Door card

- **Purpose.** A card, row or strip that is itself a link to another page.
- **Anatomy.** `a` wrapping a `.card`-like box > title, sub, optional path tag or door mark (`↗` only for external doors).
- **Variants kept.**
  - `card door`: a whole card (`a.card.ov`, `a.card--interactive`, `a.doc`).
  - `row door`: a list row that navigates (`a.trow`, `.lassetrow`, `.chanflag`).
  - `route trio`: the CRM record's three route cards (`.crm__go .crm__route`).
  - `ask card`: the Brief's ask cards (`.brief__ask`).
  - `cta strip`: 3px accent left rule strip (`.ccta`, `.handoff`, `.plans__cta`).
- **States.** Default; hover; focus-visible (global ring). The canonical hover is a border change to `--accent` (the most common in the mockup) plus pointer; row doors hover with a `--surface-2` fill.
- **Styling.** As DS-COMP-7 for card doors. Row door: grid, padding 16 24, gap 12, 1px top `--border`; hover fill `--surface-2` (#f2f2f2 light, #171619 dark).
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | card-door-ov | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | card-door-ov | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | card-door-ov | focus-visible | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | card-door-interactive | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | card-door-interactive | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | card-door-interactive | focus-visible | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | card-door-doc | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | card-door-doc | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | card-door-doc | focus-visible | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | ask-card | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | ask-card | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | row-door | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | row-door | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | row-door | focus-visible | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | route-trio | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | placeholder-sibling-drift | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | placeholder-sibling-drift | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | placeholder-sibling-drift | focus-visible | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `.card--interactive` `hub-ds/primitives.css:161-166`; `.doc` `app.css:3046-3055`; `.proj__door` `app.css:3854-3855`, `5657`; `a.trow` `app.css:1751-1754`; `.lassetrow` `app.css:3917-3928`; `.chanflag` `app.css:1502`; `.brief__ask` `app.css:1058` and again `7064`; `.ccta` `app.css:1520`; `.plans__cta` `app.css:1606`; `.handoff` `weekly-report/index.html:50`; `.crm__route` `app.css:6691-6711`, `clientrecord.js:228-244`; `libraryDoc` `ui.js:3615`. Placeholder sibling cards: `route-home/index.html:72-95`. Door marks: `doorMark()` `ui.js:1047`, `.door__mark` `app.css:11827-11831`.
- **Usages.**
  - SHELL: SH-43, SH-55.
  - AGENCY: AG-P17, AG-A7.
  - CLIENT: TR-08, BR-44, the Docs `a.doc` cards and `.lassetrow` rows, WK-14, WK-23, MO-04, AC-17.
  - WORKBENCH: SS-W05, WP-W05, CN-W12, WB SH-17.
  - PORTAL: PH-15, PH-16, PH-17, PT-08, PLK-03, PLK-06, PC-09.
  - DOCK: CR-07 to CR-09.
- **Drift.** Hover is drawn five ways:
  - `a.card.ov`, `.doc`, `.card--interactive`: accent border (full accent on `.doc`, accent 22% mix on `--interactive`, which also lifts and deepens its shadow, measured). Keep full accent, no lift (DR-2: border-only hover everywhere).
  - `.brief__ask`: `--border-strong` plus `--surface-2`. Drop.
  - `.crm__route`: `--text` border. Drop.
  - The placeholder page's `a.card` has no hover rule at all and resets underline with an inline style (measured: hover and focus change nothing). Drop.
  - The launcher `a.vcard` hovers to `--surface-2` with a 2px accent left border on four cards (page-local). Drop.
  - Lookalikes that are not doors: `div.doc` (PLK-04, PLV-03), `.drive__item` (PLD-03, not a door by ruling), the lever cards (VO-02, CL-I3). They must not take door styling.
- **Defects not to copy.** Card doors `a.card.ov` (portal home) and `a.card--interactive` (Track record) show **no focus ring**: the measured focus-visible state changes nothing, because the card's own shadow overrides the global ring. `↗` on an in-app door (AG D-A15). A designed sibling labelled "Open placeholder page" (SHELL I3). Doc cards promise doors they lack (PO-I17). The CTA leaves the canonical portal (PO-D2). `.card--interactive` has no rule in `app.css`, only in the Hub file.

### DS-COMP-9 Verdict strip

- **Purpose.** The page's answer first: a bordered block of verdict rows, each a status band, a headline sentence and its period.
- **Anatomy.** `.vstrip` > `.vrow` × n (status band track `.band`, verdict text, period, source cite).
- **Variants kept.** `full`; `bare` (`ui.js:1212`); `headline-only` (OB-W01, TS-W01); `pair` (two books side by side, GA-W01 and Meta).
- **States.** None interactive.
- **Styling.** Box: 1px `--border-strong` (#000 32% light; #fafafa 20% dark), ground `--surface`. Row: grid, padding 16 41.6 16 16, gap 12 16. At 390 the rows stack.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | bare | default | 1480 | (screenshot, kept private) (scale 0.85) | (screenshot, kept private) (scale 0.85) |
  | bare | default | 390 | (screenshot, kept private) (scale 0.7) | (screenshot, kept private) (scale 0.7) |
  | full | default | 1480 | (screenshot, kept private) (scale 0.5) | (screenshot, kept private) (scale 0.5) |
  | full | default | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | row | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | row | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `verdictStrip()` `ui.js:1269`, `verdictRow()` `ui.js:1187-1283`; CSS `.vstrip`, `.vrow` `app.css:760-808`; band track `bandTrack()` `ui.js:931`, `.band` `app.css:820`.
- **Usages.**
  - AGENCY: AG-K4, AG-K5 (AG-P7, E6, C8, S7).
  - WORKBENCH: WB SH-10, WB SH-11; OB-W01, TS-W01, GA-W01.
  - CLIENT: BR-29, BR-30, WK-13, MO-05, TR-04.
  - PORTAL: PH-13, PT-04.
- **Drift.** None in markup: one builder. The variants above are its arguments.
- **Defects not to copy.** Verdict periods disagree with the header period (WB D21). One verdict field has two vocabularies (CL-I7).

### DS-COMP-10 Finding card

- **Purpose.** A suggested finding with its evidence and a next move, marked as machine-made.
- **Anatomy.** `.ai` > `.ai__head` (marker, title) > body > next-move slot (`mountTopRec` pager on Site health) > actions (Dismiss, Create task). Optionally a priors block (`.prior`).
- **Variants kept.** `finding`; `finding with pager` (`.toprec__head`, AG-S8).
- **States.** Default. The inline Create task form opens inside it (DS-COMP-26).
- **Styling.** 1px `--border` on three sides and a 2px `--accent` left rule; no fill; no radius. 768 wide on Portfolio.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | finding | default | 1480 | (screenshot, kept private) | (screenshot, kept private) (scale 0.85) |

- **Construction.** `aiCard()` `ui.js:647`; `mountTopRec()` `ui.js:1239-1259`; CSS `.ai` `app.css:452-483`, `.toprec__head` `app.css:1388`; priors `priorBlock()` `ui.js:2179`, `.prior` `app.css:1292`.
- **Usages.** AGENCY: AG-K10 (AG-P11, E20, C24, S8). WORKBENCH: WB SH-15, WB SH-16, SI-W02.
- **Drift.** None beyond the pager variant.
- **Defects not to copy.** Dismiss does nothing (AG D-A1, WB D1). "See the maths" is dead (WB D2). Both are placeholders, built real and tracked (`PLACEHOLDERS.md`, DS-COMP-10).

### DS-COMP-11 Recommendation card

- **Purpose.** One recommendation in a report, with its reason, the ask, the decision buttons and its history.
- **Anatomy.** `.rec` (2px accent left rule) > kind and status pills > title > reason > what we'll do > priors (`.prior`) > actions (Approve, Discuss, Send to <owner>, Book a call). The discuss panel opens inline (RC-09).
- **Variants kept.** `needs decision`; `approved` (disabled Approved button); `needsKind none` (no actions); `queue item` (`.rq__item` wraps it on the `/projects/` Review queue).
- **States.** Default; discussing (reply box open); approved.
- **Styling.** 2px `--accent` left rule; body Sans 14; pills are PRIMITIVES.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | needs-decision | default | 1480 | (screenshot, kept private) (scale 0.6) | (screenshot, kept private) (scale 0.5) |

- **Construction.** `recCard()` `ui.js:795-823`; `mountRecCards()` `ui.js:826-842`; CSS `.rec` `app.css:495-531`; queue wrapper `.rq__item` `app.css:7945`.
- **Usages.** CLIENT: RC-01 to RC-11, WK-17, MO-10. BOARDS: P-41 to P-50 (queue).
- **Drift.** The queue card puts a head row of pills above the `.rec` frame. Keep as `queue item`.
- **Defects not to copy.** Send to <owner> and Book a call have no handler (CL-D1): placeholders, built real and tracked (`PLACEHOLDERS.md`, DS-COMP-11). A card with no priors renders no history block (CL-I6). A queue card prints WHAT WE'LL DO over an empty column (BOARDS D-21). Request changes asks for no reason (PO-I9).

### DS-COMP-12 Disclosure layer

- **Purpose.** A collapsible band of a page that holds deeper detail under a one-line summary.
- **Anatomy.** `.layer` (a `details`) > `summary.layer__sum` (title, count, chevron) > body (cards, tables).
- **Variants kept.** One; open or closed by default per page.
- **States.** Closed; open; summary hover `--surface-2`; summary focus-visible (global ring).
- **Styling.** Layer: 1px `--border`, ground `--surface`. Summary: flex, padding 12 16, gap 12, 1px bottom `--rule`; hover `--surface-2` (#f2f2f2 / #171619).
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | summary | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | summary | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | summary | focus-visible | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | layer | closed | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | summary-workbench | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | summary-workbench | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `layer()` `ui.js:1291`; CSS `app.css:854-879`.
- **Usages.** AGENCY: AG-K15 (AG-E18, AG-S15, S17, S19, S22, S23). WORKBENCH: WB SH-18 (the workbench's section structure). CLIENT: BR-31, BR-43, BR-55 to BR-58, WK-15.
- **Drift.** The layer insets its cards 17px (`app.css:854`). Keep.
- **Defects not to copy.** The Revenue layer is shut by default and hides its only content (WB D19).

## Lists

### DS-COMP-13 List row

- **Purpose.** One row in a list that is not a board: a page list inside a card, or a list inside a dock panel. This is the consolidation of the largest drift in the mockup: at least nineteen row dialects draw the same thing.
- **Anatomy.** Row container (grid) > leading slot (glyph, avatar, status dot or tick) > main (title, sub or meta line) > trailing slot (value, chip, time, hover tools). A list may have a column head row (`.tl__head`), a group head (DS-COMP-22) and a list foot (fold or page control).
- **Variants kept.**
  - `page row`: padding 16 24, 1px top `--border` (the `a.trow` measurement). Doors use DS-COMP-8's `row door`.
  - `panel row`: the dock's density, padding 8 to 10 20.
  - `notice row`: 2px left rule, for notifications (`.nt__row`) and pinned notes (`.dp__note`).
  - `record row`: label and value (`.detail__row`, `.mmeta__row`, `.setrow`).
- **States.** Task states (from `TASK-PAGE.md`, written in at build-ready): `gate step` (DT-04: leading DS-PRIM-17 eye, no tick, trailing DS-PRIM-25 key tag note that wraps to its own line at 390) and `archived` (DT-05: text `--text-2`). Default; hover (`--surface-2` fill); selected (`.is-on` on a client row scopes the Projects panel to it; `.dp__mark.is-here`); done (`.tl__row.is-done`); sorted head (`.tl__head .is-sort`); focus-visible (global ring); hover tools revealed.
- **Measured panel rows (1480).** Client row 433×58, grid, padding 8.8 5.6 8.8 0, hover fill `--surface` (#ffffff light, #0f0f12 dark). Task row 488×42, padding 9.6 0, 1px bottom `--border`, hover `--text` 3%. Doc row 501×90, padding 12 0, bottom `--border`. Notice row 501×65, padding 4 12, 2px `--accent` left rule, hover accent 6%. Bookmark row 501×40, flex, gap 8. Forced hover changes nothing on the doc and bookmark rows (their rules are written on children: the title turns accent, controls fade in), nor on `.arow`, `.act__row` and `.vrow`, which have no hover rule. Setting `.is-on` on a client row changes nothing on the row itself.
- **Styling (canonical: the page row).**

  | Part | Light | Dark |
  |---|---|---|
  | Row | grid, padding 16 24, gap 12, 1px top `--border` | `--border` dark |
  | Hover | `--surface-2` #f2f2f2 | #171619 |
  | Title | Sans 14/21.7 400 `--text` | #f8f8f8 |
  | Meta | Mono 300 UPPER or Sans 13 `--text-muted` | same tokens |
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | notice-row | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | notice-row | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | panel-row-client | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | panel-row-client | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | panel-row-client | on | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | panel-row-task | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | panel-row-task | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | panel-list-head | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | panel-row-doc | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | panel-row-doc | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | panel-row-bookmark | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | panel-row-bookmark | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** Page rows: `.approval` `app.css:554`, `a.trow` `app.css:1751`, `.vrow` `app.css:776`, `.grl__row` `app.css:8899`, `.tw__row` `app.css:9004-9010`, `.skc__row` `app.css:9604`, `.grad__row` `app.css:8336`, `.chan__row` `app.css:8470`, `.setrow` `app.css:3252`, `.psr__row` `app.css:10281`, `.detail__row` `app.css:3068`, `.mmeta__row` `app.css:2137`, `.opp` `app.css:1837-1849`, `.swot` `app.css:6926`, `.cc` `app.css:1864`, `.annotation` `app.css:430`; builders `peopleList` `ui.js:2717`, `loopList` `ui.js:2472`, `oppRow` `ui.js:2506`, `assetRow` `ui.js:3744`, `assetList` `ui.js:3764`. Panel rows: `.cl__row` `dock-clients.js:317`, `app.css:6466-6470`, `9381-9406`, `11583-11585`; `.tl__head`, `.tl__row` `dock-tasks.js:355`, `384`, `app.css:5105-5147`; `.dcs__row` `dock-notes.js:171`, `app.css:7474`; `.dp__mark` `dock-marks.js:71`, `app.css:6563-6567`; `.nt__row` `dock-notifications.js:453`, `app.css:9704-9716`; `.dp__note` `dock-notes.js:90`, `app.css:4546`. List feet: `.bookmore` `app.css:1758`, `.connmore`, `.pginfo` `app.css:2927`. The unused Hub `.flist` is in `hub-ds/filterable-list.css:67-99`.
- **Usages.**
  - AGENCY: AG-P13, P17, P18, P20, P25; AG-K5; AG-C15, C16, C19, C22, C27, C31, C35, C39, C46, C51, C53, C57, C60, C61; AG-E15, E16, E27, E32, E33; AG-S15, S25, S26, S27; AG-X21.
  - SHELL: SH-56, SH-60, SH-61.
  - CLIENT: BR-08, BR-41; MO-09, MO-11; TR-07; VO-08; DSY-11; DR-02 to DR-04; AC-10, AC-11; the Docs asset rows.
  - WORKBENCH: WB SH-25; SI-W07, SI-W08; FN-W03; TS-W05; RV-W05; WP-W03; EM-W05.
  - PORTAL: PH-11, PLV-05, PAC-03, PLK-06, PC-09, PC-10, PC-11, PT-07.
  - BOARDS: C-43, P-66.
  - DOCK: CL-07 to CL-11; PJ-05 to PJ-11; DC-04 to DC-08, DC-16 to DC-18; BM-02 to BM-04; NT-06, NT-07.
- **Drift.**
  - Padding comes in six values: 16; 16 24; 12 24; 8.8 24; 9.6 24; 12 0. Keep two: `page row` 16 24 and `panel row`.
  - Separators switch between a top rule and a bottom rule, and between `--rule`, `--border` and `--border`. Keep a top `--border`.
  - Row grids are bespoke per page (MO-09 72|1fr, MO-11 104|1fr, DSY-11 56|104|1fr|auto, `.vform` 26|1fr|auto|auto). Keep the slots; let the column template be a prop.
  - Panel row hover: `--surface` fill (clients), `--text` 3% (projects), title turns accent (docs), controls revealed (bookmarks), accent 6% (notifications). Keep `--surface-2` fill; notification rows keep the `--accent-wash` (8%) hover, which marks unread (DR-43, DR-11).
  - Hover-reveal of row tools uses `visibility` (CL-08 to CL-10) or `opacity` (BM-03, BM-04, CR-04). Keep one (`opacity`), and never hover-only on touch.
  - Three fold rules: fold at 8 (`.bookmore`), page by 10 (`.connmore`), no fold (AG-E31). One rule per list type (DR-44, behaviour, and TICKET-PLAN R49): card lists and tables fold at 8 with "Show n more"; ledgers page by day with "Load earlier days" and keep day headings.
  - The `.arow` rule colour is `--rule`, elsewhere `--border`. Drop `--rule`.
- **Defects not to copy.** Hover-only controls cannot be reached by touch (DOCK D-10). Filter and foot counts are typed (AG D-A3). The count line's denominator is 37, not the 14 rows shown (DOCK D-6). DSY-11 version rows do not reflow at 390 (CL-D2). The VO-04 and PLV-05 note × renders as a browser-default button (CL-D3, PO-I14). Remove has no confirm (PO-I20). Leads rows show a pointer but do nothing (BOARDS D-07).

### DS-COMP-14 Feed and ledger

- **Purpose.** Things that happened, in time order: the attention feed, the activity ledger (work log), the CRM ledger and the notification feed.
- **Anatomy.** Feed head (title, count, law line) > day or group head (sticky on the ledger) > event rows (time, actor, kind, text, open link) > optional open row detail.
- **Variants kept.**
  - `attention feed`: bordered block, head with a strong bottom rule, rows `.arow` (`.afeed`).
  - `activity ledger`: sticky day heads (`.act__day`) and a five-column row (`.act__row`: 3.2rem time, 5.5rem, 5rem, 1fr, auto); the agency ledger has a Client column, the client ledger does not.
  - `record ledger`: the dock CRM record's event rows (`.crm__ev`, `.crm__evrow`, openable).
  - `grouped feed`: notifications by group (`.nt__grp`), with a closed-items disclosure.
- **States.** Row hover; an opened ledger row; an empty filter result; the ledger at 900 collapses to two columns (`app.css:6210-6216`).
- **Styling.** Attention feed: 1px `--border-strong` outline; head flex, padding 16, gap 16, 1px bottom `--rule` (#000 / #fff 24%). Rows: grid, padding 16 38.4 16 16, gap 16. Ledger day head: sticky, 1px `--border-strong`.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | attention-feed-head | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | attention-row | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | attention-row | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | ledger-day | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | ledger-row | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | ledger-row | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | ledger-row | default | 900 | (screenshot, kept private) | (screenshot, kept private) |
  | ledger-row | hover | 900 | (screenshot, kept private) | (screenshot, kept private) |
  | record-ledger | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** Attention feed: `attentionFeed()` `ui.js:2122`, `attentionRow()` `ui.js:2044`, `.afeed`, `.afeed__head`, `.arow` `app.css:1072-1087`; action queue `.pq__head`, `.pq__law`, `.pdone` `app.css:1121-1124`, `1167`. Ledger: `activityEvents()` `ui.js:7496`, `actRows()` `ui.js:7661`, `mountActivity()` `ui.js:7702` (mounted at `agency/projects/index.html:300`, `client-portal/projects/index.html:1452`), CSS `app.css:6177-6216`. Record ledger: `clientrecord.js:533`, `648`, `app.css:6829-6841`. Grouped feed: `.nt__grp` `app.css:9684`. Night round `ol.nr` `app.css:9046-9051`.
- **Usages.**
  - AGENCY: AG-E11, E12, E14, E18; AG-C41, C42; AG-S28.
  - BOARDS: L-01 to L-08; W-01 to W-05.
  - CLIENT: BR-58, WK-20, MO-07, TR-07, DSY-11.
  - WORKBENCH: CN-W09.
  - DOCK: CR-28 to CR-30; NT-04 to NT-08.
- **Drift.**
  - The attention feed is bordered; the night round list sits in a flush card. Keep bordered.
  - Task history (`taskHistory` `ui.js:5148`, `.sbact` `app.css:3833-3845`) is a fifth ledger on the task side: handed to TASK-PAGE.
  - The ledger search is its own shape (`#actQ`, `.act__find` `app.css:6177`); see DS-COMP-16.
- **Defects not to copy.** The ledger has no paging (BOARDS D-11); rows link to legacy addresses (D-12, AG D-A12); `#queue#PA-###` is a dead door (AG D-A11); ledger rows are `div`s with no keyboard path (DOCK D-13); the Log form writes no ledger row (DOCK D-11); the build makes it write one (`PLACEHOLDERS.md`, DS-COMP-14).

## Conversation

### DS-COMP-15 Message thread and composer

- **Purpose.** A conversation: messages in order, then a composer pinned at the foot.
- **Anatomy.** `.thread` > `.msg` × n (avatar 1.35rem round, meta line with name and time, text, optional pin and edit controls) > `.thread__more` ("Show n more") > `.composer` (input, send). The AI panel draws its own bubbles (`.aip__msg--ai`, `--user`, `--note`) with a chip row and input row.
- **Variants kept.**
  - `thread` (team chat, review cards, voice notes): avatar rows, no fill. Sides by `--agency`/`--client`; `--mine` uses an accent avatar.
  - `assistant` (AI panel): boxed bubbles, the assistant's on `--surface-2` with a border, the user's on ink, notes dashed.
- **States.** Default; own message (edit pencil, pin); a pinned message; empty thread; composer focus.
- **Styling.** Thread gap 24 (`--s-5`); meta Sans 13; time 12; text .85rem/1.45. Composer gap 12 in Team, 8 in AI; only AI has a top rule.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | thread-team | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | team-people-strip | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | composer-team | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | assistant | default | 1480 | (screenshot, kept private) | (screenshot, kept private) (scale 0.85) |
  | composer-assistant | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | voice-note | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `sbMsg()` `ui.js:4912`; threads `sbThreadTeam` `ui.js:5040`, `sbThreadClient` `ui.js:5048`; team chat `dock-team.js:92`; voice notes `voiceNote` `ui.js:7096-7105`; CSS `app.css:2974-3045` (`.thread`, `.msg`, `.msg__ctl`, `.msg__edit` `5698-5711`, `.composer` `3043-3045`, `.tmc .composer` `6454`). AI: `dock-ai.js:221-224`, `565-594`; CSS `.aip__msg` `app.css:696-705`, `.aip__chips`, `.aip__inputrow` `app.css:706-717`. People strip `.tmc__strip` `app.css:6399`.
- **Usages.**
  - DOCK: DK TM-01 to TM-05 (team), AI-09 to AI-12.
  - BOARDS: R-10 to R-12; P-48 (reply box).
  - PORTAL: PP-18 to PP-20, V-04 to V-06, PLV-05.
  - CLIENT: VO-04.
  - TASKS: DT-16 (handed to TASK-PAGE).
- **Drift.**
  - Two renderers in the dock (thread against assistant). Keep both as named variants (DR-45): chat with people against chat with a model.
  - Avatar 16px on the split card, 22px on voice notes. Keep 22.
  - Review twin shows the last 3 plus "Show 5 more" with the composer inside `.thread`; the split card scrolls (`.thread__msgs` `app.css:12135`, 8 to 15rem) with the composer as a sibling. Keep the scroller.
  - Composer placeholders differ ("Leave feedback…", "Leave a comment for the team…"). Copy, not style.
  - `.note` (`app.css:426-428`) is an older note dialect. Drop.
- **Defects not to copy.** The voice note's remove × (`.vnote__x`, `app.css:3900`) never resets the native button look, so it paints the browser's own grey button face (#efefef with a UA border) in both themes (FA-CLIENT-63; build it as the DS-PRIM-2 close). The composer renders in Arial on the portal (PO-I10), and so does the dock Team composer (437 × 33, Arial 13.6: the input does not inherit the family; FA-DOCK-79, fresh audit). Build: inputs inherit Funnel Sans. The agency can edit the client's comments (BOARDS D-24). Opening Team marks a thread read (DOCK D-24).

## Boards

### DS-COMP-16 Filter and command bar

- **Purpose.** The bar above a board or list that narrows and acts on it: search, facets, presets, a funnel menu and actions.
- **Anatomy.** Search field (`.cbd__barq`, with typeahead) · funnel button (`.cbd__funnel`, corner count) and its menu (DS-COMP-24) · facet chips (`.cbd__facet[aria-pressed]`) · presets · read line (`.cbd__read`: "n of m") · actions (undo, redo, fit columns, Sync, New task) · Clear all.
- **Variants kept.**
  - `command bar` (`cmdCatBar`, `/projects/` and the client board): search, funnel, actions on one line; icons only at 900.
  - `filter bar` (`mountFilters`, CRM, review twin, portal split board): facets and presets, search at the end.
  - `page facets` (Connections, Site health: `.facets > .facet` with a count).
- **States.** Facet default, hover, focus-visible, pressed (`aria-pressed=true`: `--accent` border, `--text` ink); funnel open; typeahead open; category flagged; 900 icons-only; 390 stacked.
- **Styling.** Page facet: **no hover rule** (measured); 34 tall, padding 5.6 11.2, gap 7.2, Sans 13.12 `--text-2`, ground `--surface`, 1px `--border`, transition colour and border 120ms `--ease-out`; count in Mono `--fs-mono-sm` `--text-muted`.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | command-bar | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | command-bar | default | 900 | (screenshot, kept private) | (screenshot, kept private) |
  | command-bar | default | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | filter-bar-crm | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | filter-bar-crm | default | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | filter-bar-portal | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | page-facets | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | page-facets | default | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | page-facet | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | page-facet | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | page-facet | focus-visible | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | page-facet | pressed | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `mountBoard` `board.js:463`, `barHtml` `board.js:832` (`.cbd__cmd`), `cmdCatBar` `board.js:1016`, the filter bar `board.js:1037`, `mountFilters` `board.js:1897`. CSS `.cbd__bar` `app.css:7419-7422`, `.cbd__cmd` `app.css:11636-11648`, `.cbd__barq` `app.css:11340` (640 `11375`), `.cbd__search`, `__acts`, `__field` `app.css:7084-7092`, `.cbd__filters`, `__flabel`, `__facet`, `__lnk` `app.css:7100-7120`, `.cbd__ico` `app.css:7124`, `.cbd__barend` `app.css:10007`, `10028`, `10918`, 640 `app.css:12933-12941`. Page facets `app.css:2950-2953`. Other bars: `actionBar()` `ui.js:854` with `.actionbar` `app.css:543-551`; the ledger search `.act__find` `app.css:6177`; the gradient select bar `.gradbar` `app.css:8328-8334`.
- **Usages.**
  - BOARDS: B-01, B-04, B-05, B-22, B-25, B-26; P-02 to P-04, P-10 to P-14, P-60, P-62; M-01 to M-04; C-01 to C-07, C-30, C-40; R-01; L-01 to L-04.
  - PORTAL: PP-09 to PP-12.
  - AGENCY: AG-K14, AG-C12, AG-S11 (facets); AG-P22, P23 (segmented filter); AG-A6 (legend filter); AG-C13; AG-C48; AG-P27 (action bar).
  - CLIENT and WORKBENCH: WB SH-04, WB SH-05, WK-01 to WK-04, MO-01, MO-13, CN-W08 (report and period controls: they sit in the page header, DS-COMP-3).
  - DOCK: PJ-02, PJ-03 (`.tsearch` token box), DC-14 (`.dcs__search`), CL-05, CR-20 to CR-22: see DS-COMP-22.
- **Drift.**
  - Status filtering is drawn three ways on agency pages: facets (Connections, Site health), a segmented control (Portfolio), a legend strip (Activation map). Keep facets; the Activation map legend stays a legend that filters by status (DR-46).
  - The review twin puts search on its own line; the portal puts it in `.cbd__barend`. Keep `.cbd__barend`.
  - Portal presets are drawn as `.cbd__facet` where the board uses `.cbd__preset`. The portal Clear all is `--text-muted` where the board's is primary ink. Keep the board's.
  - CRM actions sit on a second line; kept (DR-47).
  - The ledger search has a Clear button and no chips. Fold into `filter bar`.
  - **Scope chip (TICKET-PLAN R48).** On a client's board the scope chip names the page: a label that cannot be removed, styled apart from the filter chips (a DS-PRIM-11 outline chip with no ×).
  - The Hub `.filter-pills` (`hub-ds/filterable-list.css:33-65`) is unused. Drop.
- **Defects not to copy.** The command bar stays live on panels that are not the board (BOARDS D-03). Typeahead matches any substring (D-20). The funnel menu breaks the 16px gutter at 390 (D-22). No filter row on the agency Reviews tab (D-26). The facet count is typed (AG D-A3). Clicking a page facet re-renders the row, so its pressed state had to be set by attribute for the shot.

### DS-COMP-17 Board table

- **Purpose.** The board is a table, not a kanban: column heads that sort and resize, group rows, then task or client rows with hover tools.
- **Anatomy.** `.cbd` > `.cbd__tbl` > `thead` of `.cbd__th` (label, sort arrow, resize grip) > `tr.cbd__grp` group rows (fold, name, count) > rows (tick or capacity, name, cells, comment count, hover tools `.cbd__routes`).
- **Variants kept.** `projects` (39px rows, name 400, hover tools in a popover); `crm` (43px rows, name 500, route trio in flow); `leads` (auto layout, no grips); `swot` (auto layout, 41px rows).
- **States.** Row default, hover, focus-visible, editing a cell, completed; head hover, sorted; group folded; 900 tight; 390.
- **Styling.**

  | Part | Light | Dark |
  |---|---|---|
  | Column head | Chivo Mono 12/12 400 UPPER +.24px, `--text-muted` #8c857f, padding 8.8 12, gap 6.4; hover `--text` | `--text-muted` #f8f8f8 55 percent (DR-10 fold; the mockup drew 46); hover #f8f8f8 |
  | Group row | 46 tall (padding 13.6 8 5.6, 1px top `--border`, `--bg`); the first group 38 (no top rule, padding-top 5.6). Label Funnel Display 16.8 (`1.05rem`) 500 `--text`; wait reasons `.cbd__grpr` after a rule in `--text-muted` (`app.css:11965-12019`; heights reconciled by lane RECONCILE-LOOK against FA-BOARDS-26) | same, `--bg` dark |
  | Row (projects) | 39 tall, hover `--surface-2` #f2f2f2, focus-visible ring plus outline | hover #171619 |
  | Row (crm) | 43 tall, ground #fafafa, hover `--surface-2` | ground #0d0d0f, hover #171619 |
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | group-row | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | row-projects | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | row-projects | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | row-projects | focus-visible | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | row-projects | default | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | row-projects | hover | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | row-projects | focus-visible | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | column-head | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | column-head | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | row-crm | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | row-crm | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `board.js` (the shared board machine, BOARDS §1); `projectsboard.js`, `crmboard.js`. CSS `.cbd` `app.css:7078`, rows `app.css:7175-7180`, `.cbd__routes` `app.css:7207`, `.cbd__routes--pop` `app.css:10990`, sort arrow `app.css:11527`, static comment `.cbd__cmt--static` `app.css:9194`.
- **Usages.** BOARDS: B-15 to B-21, B-24; P-20 to P-28, P-30 to P-37, P-64, P-66; C-10 to C-17, C-20 to C-25, C-31, C-32, C-43; M-05, M-08.
- **Drift.**
  - Row height 39 against 43, name weight 400 against 500 (Projects against CRM). Ruled (DR-48): one row height, 39, and one name weight, 400 (the Projects board).
  - Projects hover tools are an absolute popover; the CRM route trio reserves its width in flow (BOARDS D-13). Keep the popover.
  - The comment cell is a sort button on Projects and a static span on CRM. Keep the button.
  - The CRM capacity squares reuse the stage strip's `.stg__rb--sm` at 22px against 29px. Keep one size.
- **Defects not to copy.** Heads and grips have no keyboard path (BOARDS D-05). An open cell editor grows the row by 7px (D-09); the build holds the row height and sizes the editor to the cell (TICKET-PLAN R47). The CRM name vanishes at 390 (D-13). Pressing the Work available head throws (D-14). Leads rows look clickable and do nothing (D-07). The burn bar in P-28 is DS-COMP-29.

### DS-COMP-18 Board card

- **Purpose.** A card for one piece of work under review: title, status, the thing to look at, the conversation and the decision.
- **Anatomy.** Head (glyph, title, status chip on the right) > sub line > viewer or preview > facts (and a meter on a project card) > thread (DS-COMP-15) > actions (Approve, Request changes).
- **Variants kept.**
  - `review` (the canonical card: agency review twin and the portal's review step).
  - `project` (portal split board: a meter and facts, no actions).
  - `step` (no glyph and no viewer).
- **States.** Default; approved (Approved button disabled); empty thread; editing own comment; discussing.
- **Styling.** A `.card` (DS-COMP-7) laid out as a grid: padding 24, gap 24, `--surface`, 1px `--border`, `--shadow-sm`. Twin 572×464, split 584×407 at 1480.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | review-twin | default | 1480 | (screenshot, kept private) (scale 0.85) | (screenshot, kept private) (scale 0.85) |
  | review-split | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | review-split | default | 390 | (screenshot, kept private) | (screenshot, kept private) |
  | project | default | 1480 | (screenshot, kept private) (scale 0.7) | (screenshot, kept private) (scale 0.7) |

- **Construction.** Review twin `reviewboard.js:257-328`, `.rgrid` `app.css:10357`. Split card `cardShell` `client-portal/projects/index.html:903-915`, `.pboard .rcard` `app.css:12161`, `.tcard__head` `app.css:12176`, board `.pstack` `app.css:12095`, `.pboard` `app.css:12105`.
- **Usages.** BOARDS: R-02 to R-12; V-01 to V-06. PORTAL: PP-13 to PP-20.
- **Drift.**
  - The twin nests glyph and title in a `.row` inside `.card__head`; the split card uses a flat `.tcard__head` whose chip wraps unevenly (PO-I11). Keep the twin's head.
  - The twin's sub reads `{project} · comments sync…`. The split card's is a status sentence. Copy, keep the status sentence.
  - The twin has View task. The split card has none, by ruling.
  - The twin goes to one column at ≤900; `.pboard` at ≤1279. Ruled (DR-49): one breakpoint, one column at ≤ 900 on both faces.
  - The queue card on `/projects/` is DS-COMP-11's `queue item`, not this.
- **Defects not to copy.** Twin cards are too narrow at 1480 (BOARDS D-10). Reviews boards open with a project card (PO-I12). Client-voiced copy on the agency face (D-25).

### DS-COMP-19 Stage strip

- **Purpose.** The client board's strip of stages across the top: each stage a small card with a capacity row, one of them picked.
- **Anatomy.** `.jband` > `.stg` × 7 (name, count, capacity squares `.stg__rb`) .
- **Variants kept.** One. `.stg--pri` marks the priority stage.
- **Styling.** Strip: 1px `--border-strong`, padding 16, ground `--bg`. Stage: 152×183, grid, padding 12, gap 2.4, 1px `--border`. Picked: ground `--rail-bg` (#f5f5f5; dark #131316) and a 1px `--text` border. **No hover rule** (measured).
- **States.** Default; hover; focus-visible; picked (`.is-on`). Seven across, four at a content box ≤1000px, two at ≤640px. Four across at 900 (cards 199 px wide) is accepted (TICKET-PLAN R59).
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | strip | default | 1480 | (screenshot, kept private) (scale 0.85) | (screenshot, kept private) (scale 0.85) |
  | strip | default | 900 | (screenshot, kept private) (scale 0.85) | (screenshot, kept private) |
  | strip | default | 390 | (screenshot, kept private) (scale 0.85) | (screenshot, kept private) (scale 0.85) |
  | stage | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | stage | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | stage | focus-visible | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | stage | on | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `mountDeck` `deck.js:118`; CSS `.jband` `app.css:7279`, `.stg` `app.css:7283`, `.stg__rb` `app.css:7297`.
- **Usages.** BOARDS: S-01 to S-05; C-24 (reuses the capacity squares).
- **Drift.** C-24 reuses `.stg__rb--sm` at 22px against 29px here. See DS-COMP-17.
- **Defects not to copy.** None flagged on the strip itself.

### DS-COMP-20 Roadmap columns

- **Purpose.** The only true columns in the mockup: the client growth roadmap as Now, Next and Later columns of items.
- **Anatomy.** `.road` > `.road__col` × 3 > `.road__head` > `.road__item` × n (`.is-soft` for Later).
- **Variants kept.** One.
- **States.** Default; soft item.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | roadmap | default | 1480 | (screenshot, kept private) (scale 0.85) | (screenshot, kept private) (scale 0.85) |

- **Construction.** Page-local CSS `client-portal/projects/index.html:30-35`.
- **Usages.** BOARDS: G-03 to G-05. PORTAL: PG-03, PG-04.
- **Drift.** None; it is drawn once, in page-local CSS. Move to the shared sheet at port.
- **Defects not to copy.** The roadmap content sits under `[data-unwired]` (a placeholder in a designed frame, BOARDS G-01 to G-05).

## Dock interiors

The dock's edge rail, its tabs, the panel slide in and out, panel width, seating and stacking belong to lane SIDEBAR. These entries cover what is inside a panel. Open any panel from `/dashboard/` with `.dock__tab[data-dock-tab="<id>"]`; the ids are `notes` (Docs), `marks` (Bookmarks), `task`, `todos` (Projects), `clients`, `team`, `notifs` and `ai` (`dockboot.js:88-278`, `dock.js:628`). At 1480 with the full rail a panel floats; the crops were taken there.

### DS-COMP-21 Dock panel header

Alias of **DS-SIDE-8** Panel head (`../SIDEBAR.md`), with its buttons at DS-SIDE-9: the dock is the reference (#298). This entry's per-panel slot table, AI-head drift and shots are carried in `../CATALOGUE.md`, "Carried from retired entries".

### DS-COMP-22 Dock panel body parts

- **Purpose.** The repeated parts that make up a panel body. Each is drawn two or three ways today. This entry names one of each.
- **Anatomy and parts kept.**

  | Part | Canonical | Other drawings (drop) |
  |---|---|---|
  | Body frame | `.dpanel__body` (gap `--s-4`) | `.aip__scroll` (gap `--s-3`; `dock.js:926-930` has a fallback just for it) |
  | Walk-back row | `.cbk` glyph plus a 15px/500 title | `.dcv__back` glyph plus uppercase label, no title |
  | Section label (mono overline) | one class | `.dcs__label`, `.crm__k`, `.nt__bh` |
  | Label row with an action | `.crm__k--row` | none |
  | Count or reading line | one class, `--text-muted`, not uppercase | `.cl__count` (uppercase), `.dcs__count`, `.dcs__read` and `.tsearch__read` in `--text-muted` |
  | Group head | `.nt__ghead` | none |
  | Ruled sub-section | `.dcs` (top rule, `--s-6` margin) | none |
  | Panel search | Alias: DS-PRIM-6, dock panel search variant (with `token search`, `.tsearch`) | see DS-PRIM-6 |
  | Tag field | Alias: folded DS-TASK-2 (`../TASK-PAGE.md`), variant `tag field` | none |
  | Record identity head | `.crm__id` | none |
  | Action stamp | `.crm__stamp` | `.dpanel__stamp` |
  | Next-up strip | `.crm__next` | none |

- **States.** Search focus; token search with tags; record edit mode (pencil on hover of `.crm__id`).
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | body-notifs | default | 1480 | (screenshot, kept private) (scale 0.5) | (screenshot, kept private) (scale 0.5) |
  | group-head | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | count-line | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | token-search | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | docs-search-drift | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | record-identity | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | walk-back | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `.dpanel__body` `app.css:4479`; `.aip__scroll` `app.css:701`; `.cbk` `dock-clients.js:268`, `app.css:6496-6500`; `.dcv__back` `dock-notes.js:214`, `app.css:7497-7502`; `.dcs` `app.css:7459-7468`; `.crm__k` `app.css:6809-6811`; `.nt__bh` `app.css:9695`; `.nt__ghead` `app.css:9685`; `.nt__closed`, `.nt__summary` `app.css:9740-9746`; `.cl__count` `app.css:6464`; `.cl__find` `app.css:6462`; `.tsearch`, `.ttag` `dock-tasks.js:372`, `app.css:6514-6531`; `.crm__id` `clientrecord.js:176`, `app.css:6650`; `.crm__stamp` `app.css:6679`; `.crm__next` `clientrecord.js:141`, `app.css:6719-6728`.
- **Usages.** DOCK: CL-05, CL-06, CL-13, CL-14; DC-13 to DC-15, DC-20; PJ-02 to PJ-04; CR-01 to CR-04, CR-10 to CR-15, CR-20 to CR-22, CR-25, CR-26, CR-31; NT-02, NT-04, NT-05, NT-08; CL-02.
- **Drift.** In the table above. The summary line `.nt__sum` clashes in name with `.nt__summary`: rename at port.
- **Defects not to copy.** Three empty-state classes for one job (`.dp__empty`, `.tl__none`, `.crm__none`): DS-PRIM-28. The filing Client select truncates at 550px (DOCK D-15). The Bookmarks edit pencil hovers in danger red because it shares `.dp__drop` (D-17).

### DS-COMP-23 Panel tab set

- **Purpose.** Tabs inside a panel: the notification kinds, and the AI conversations (which can be added, renamed and closed).
- **Anatomy.** `.cmtabs` > `.cmtab` × n (label, optional count) > selected mark; AI adds `.cmtab__x` close and `.cmtab__new`.
- **Variants kept.** `static` (notifications); `set` (`.cmtabs--set`, AI: add, close, rename by double-click, `.cmtab--edit`).
- **States.** Default; selected; hover; rename.
- **Styling.** Static set: 34 tall, flex, gap 16, 1px bottom `--border`. AI set: 45 tall, padding 12 24 0, gap 12, 1px bottom `--border`.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | static | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | set | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** CSS `app.css:5299-5314`; notifications `dock-notifications.js:671`; AI `dock-ai.js:218`, `653-664`, rename `dock-ai.js:750`.
- **Usages.** DOCK: NT-03; AI-06 to AI-08. TASKS: DP-11 to DP-13, DT-14 (handed to TASK-PAGE).
- **Drift.** None: one component used three places.
- **Defects not to copy.** None flagged.

## Overlays

### DS-COMP-24 Popover menu

Alias of **DS-PRIM-19** Menu and popover (`PRIMITIVES.md`): the same classes (`.sel__menu`, `.cbd__menu`, `.dp__pop`, `.bkpop`). This entry's variant names, usages and shots are carried in `../CATALOGUE.md`, "Carried from retired entries". The border-colour and `.bkpop` disagreements are ruling DR-4.

### DS-COMP-25 Modal, sheet and drawer

- **Purpose.** Recorded so the gap is visible: the mockup has **no modal dialog**. Confirms are inline, and the only sheet is the AI bottom sheet.
- **What exists.**
  - `inline confirm`: a confirm drawn in place (BR-12 dismiss confirm; CN-W07 billed "Spend it / Cancel", which cannot be reached, WB D9). The canonical confirm: inline confirm is the house pattern and no modal is built (DR-53).
  - The task body `.sb` is **not** a drawer: since 28 July it mounts inside the dock's Task panel (`ui.js:6262-6285`, DS-SIDE-7), and the fixed-drawer rule `app.css:3769-3775` is dead (TASK-PAGE defect row 43). No `.sb` z-layer is built (DR-19).
  - `AI bottom sheet`: the AI panel becomes a bottom sheet at ≤900 (`.aipanel`, `--aip-sheet`). Panel geometry is SIDEBAR's.
  - The Hub `.modal` (`hub-ds/primitives.css:398-476`) exists and is unused.
- **Shots.** None: nothing to shoot that another lane does not own. The inline confirm is visible in the inventory capture `captures/CLIENT/brief--dismiss-confirm/`.
- **Construction.** `.aipanel` `app.css:684-694`, `718`.
- **Usages.** CLIENT: BR-12. WORKBENCH: CN-W07.
- **Drift.** None to consolidate.
- **Defects not to copy.** Remove has no confirm (PO-I20). The billed confirm cannot be reached in mock mode (WB D9).

## Forms

### DS-COMP-26 Form layout

- **Purpose.** How fields are laid out in a form: a tinted block of labelled fields in a grid, with actions at the foot.
- **Anatomy.** `.taskform` (`--surface-2` block) > `.tf__grid` of fields (`.tf__k` mono label over an input on `--bg`, accent focus) > actions row.
- **Variants kept.**
  - `inline form` (`.taskform`: the new-task form, the voice note form, the docs adder, the finding card's Create task). Grid of 5 columns; 4 at 1279, 2 at 900, 1 at 640.
  - `settings rows` (`.set__card > .set > .setrow`: label and control per row).
  - `panel form` (dock: the Docs add block `.dp__add`, filing `.dp__filing`, bookmark edit `.dp__markform`, the CRM record's edit mode and person card `.crm__pc`, the log row `.crm__logrow`).
  - `booking` (`bookingPanel`, `.bk__grid`): keep; it is a picker, not a field grid.
- **States.** Empty; focused field (accent border plus 2px ring); editing (record); saved.
- **Styling.** Label: Mono UPPER `--text-muted`; input on `--bg`, focus `--accent`. Block ground `--surface-2`.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | inline-form | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | settings-rows | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | panel-form-docs | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `.taskform`, `.tf__*` `app.css:2343-2369`; built by `taskDrawer` `ui.js:3471`, `sbField` `ui.js:4286`, the inline new task `ui.js:704-731`, `voiceNoteForm` `ui.js:7142`, `assetAdder` `ui.js:3780`. Settings rows `app.css:3250-3258`, `client-portal/account/index.html:590-640`. Dock: `.dp__add`, `.dp__field`, `.dp__addfoot` `app.css:4532-4541`; `.dp__filing` `dock-notes.js:102`, `app.css:7547`; `.dp__markform` `dock-marks.js:58`, `app.css:6569-6571`; `.crm__pc` `clientrecord.js:381-416`, `app.css:6791-6804`; `.crm__logrow` `app.css:6823`. Booking `bookingPanel` `ui.js:3088`, `.bk__grid` `app.css:3322`. Ask box `askBox` `ui.js:1477`, `.askbox` `app.css:1020`. Field row `.fieldrow.psadd` `app.css:5079`. The unused kit: `hub-ds/forms-kit.css:345-404` (`.form-split`, `-stack`, `-row`, `-actions`).
- **Usages.**
  - AGENCY: AG-C54, AG-C61, AG-E16, AG-K10, AG-X20 to X23.
  - CLIENT: BR-18 to BR-26, BR-45, RC-09, VO-06, DSY-08, DSY-09, AC-10, AC-18, AC-19, the docs adder.
  - WORKBENCH: WB SH-16, SI-W04 (batch console), CN-W11.
  - PORTAL: PC-04 to PC-08, PLV-07, PB-03 to PB-09.
  - BOARDS: P-48 (reply box).
  - DOCK: DC-01 to DC-03, DC-09 to DC-11, BM-05 to BM-08, CR-02 to CR-04, CR-12 to CR-15, CR-23, CR-24, CR-26, CR-27.
- **Drift.**
  - Each inline form is page-built with no shared field-group wrapper (AG-C61, AG-E16). Fold into `inline form`.
  - Portal Contact labels are Sans 13.6 on `--surface-2` (page-local CSS, `contact/index.html:17-24`); Voice labels are Mono 12 UPPER with the textarea on `--bg`. Keep the Mono label.
  - AC-10 inputs sit on `--surface-2`, not `--bg`. Drop.
  - The Voice note form (`.taskform.vnf`) has no `--surface-2` block: a 1px top `--border` rule, padding-top 16, gap 16 (measured). Keep the tinted block; the Voice note form gets it (DR-50).
  - The Hub forms kit layout classes are unused. Drop.
- **Defects not to copy.** Save and approve has no handler (AG D-A6). Batch console controls are inert (WB D7). Open a ticket creates nothing (PO-D5). These are placeholders: the build makes each real and tracked (`PLACEHOLDERS.md`, DS-COMP-26). Escape in a panel field closes the panel (DOCK D-22). An unwired primary button is invisible (CL-D4).

## Charts

Every chart is hand-drawn SVG from `assets/charts.js` (or `ui.js` for the inline kinds). Shared dress: axis labels in Mono 10 at 0.45 opacity (`fmtAxis` `charts.js:255`); gridlines in `currentColor` at 0.09; series colours passed by the page (`var(--text)`, `var(--accent)`, `var(--lilac)` or a data colour). **There are no chart tooltips and no legend builder.** Legends are hand-built per page from `.legend` (`app.css:613-614`) and `.swatch` (`app.css:360`), for example `agency/executive/index.html:123`, `497`. Charts have no accessible name (WB D28). Number formatters: `money`, `pct`, `delta` `charts.js:261-276`.

### DS-COMP-27 Axis chart (line, column)

- **Purpose.** A value over time on axes.
- **Anatomy.** SVG > gridlines > y and x labels > series (line with optional area; or bars) > optional annotations (dashed rule plus a numbered 14px flag on `--bg`) > hand-built legend below.
- **Variants kept.** `line` (`lineChart`, 760×240 viewBox, padL 44; stroke 1.8, optional area at 0.10, dashed and dot options); `column` (`columnChart`, grouped or stacked, bar width ≤26, opacity 0.9, optional dashed line series).
- **States.** None: no hover, no tooltip.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | line | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | column | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Shot note.** The column shot is AG-S20 on Site health ("Requests blocked at the edge").
- **Construction.** `lineChart` `charts.js:47-100`; `columnChart` `charts.js:107-158`; the Executive mount `agency/executive/index.html:308`.
- **Usages.** AGENCY: AG-E8 (line), AG-S20 (column). WORKBENCH: SS-W02, MO-07 (line); GA-W04 (column).
- **Drift.** None in construction.
- **Defects not to copy.** AG-E8's second series is rescaled by 2.4 (AG D-A5); the build gives managed spend its own labelled right-hand axis (TICKET-PLAN R58). Line, column and donut charts show the value on hover and keyboard focus (TICKET-PLAN R57, behaviour). The SS-W02 line plots the wrong data (WB D13). The column axis and the "$0" figures are wrong (WB D18). No tooltip and no accessible name (D28).

### DS-COMP-28 Radial chart (donut, gauge, score dial)

- **Purpose.** A share of a whole or a score against a target.
- **Variants kept.**
  - `donut` (`donut`: size 150, inner 0.62; centre value Display 19/500 over a Mono 9 label).
  - `gauge` (`gauge`: half arc, stroke 9, track at 0.12, target tick, value Display 21).
  - `score dial` (`scoreDial`, `scoreBand`: ring coloured by `.dial.is-ok`, `.is-warn`, `.is-bad`).
- **States.** Status colour on the dial only.
- **Shot note.** The donut is AG-E23 and the score dial AG-S24 ("Lighthouse score"). The gauge (AG-S22) was not cropped in this pass.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | score-dial | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | donut | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `donut` `charts.js:163-186`; `gauge` `charts.js:191-220`; `scoreDial`, `scoreBand` `charts.js:293-304`; `.dial` `app.css:1827-1835`. Unused: `heatGrid` `charts.js:230` (`.heat` `app.css:440-441`, colour-mix of `--accent`, `title` tooltip only).
- **Usages.** AGENCY: AG-E23 (donut), AG-S22 (gauge), AG-S24 (score dial). WORKBENCH: TL-W05 (donut), CL-W04 (gauge), WP-W02 (score dial).
- **Drift.** None in construction. `heatGrid` has no caller: drop or rule.
- **Defects not to copy.** No accessible name (WB D28).

### DS-COMP-29 Inline chart (sparkline, bar list, band track)

- **Purpose.** A small chart that sits inside a row, a stat or a card.
- **Variants kept.**
  - `sparkline` (`sparkline`: default 120×30, area at 0.09, stroke 1.5, end dot r 2.2, `currentColor`).
  - `bar list` (`bars` in `ui.js`: labelled horizontal bars, fill ink 82%, 88px label at 640).
  - `band track` (`bandTrack`: the verdict row's range band).
  - `burn bar` (`.brn`, the board's budget column).
  The meter (`.meter`, DS-K6) is a PRIMITIVES item.
- **States.** None.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | sparkline | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | bar-list | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | band-track | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `sparkline` `charts.js:27-38`; `bars` `ui.js:573`, `.barlist` `app.css:372-379`; `bandTrack` `ui.js:931`, `.band`, `.band__track` `app.css:820`; `.brn` `app.css:8230`. Funnel markup only: `app.css:381-422`.
- **Usages.**
  - AGENCY: AG-P24b, AG-S12 (sparkline); AG-K4, AG-K5 (band).
  - CLIENT: WK-12, BR-55 (sparkline); WK-22 (bar list).
  - WORKBENCH: SS-W03, MA-W02, LR-W04, LR-W05, CL-W05, FM-W05 (bar list); WB SH-12 (band).
  - BOARDS: P-28 (burn bar).
- **Drift.** The AG-P24b sparkline is 74×22 in accent; AG-S12's is 110×26 with no area; WK-12's is 880×120. Keep size as a prop; the area is on everywhere, including the response-time line (DR-51).
- **Defects not to copy.** None beyond D28.

### DS-COMP-30 Project timeline (Gantt)

- **Purpose.** The client's projects as bars across weeks, on the Brief.
- **Anatomy.** `.gantt` > week scale > one row per project (label, bar, today line). Hovering a bar offers to open the project.
- **Variants kept.** One.
- **States.** Default; bar hover.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | gantt | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `projectTimeline` `ui.js:7986`; `.gantt` `app.css:8136-8193`; `mountTimeline` `ui.js:8124`. `monthCal` `ui.js:8160` has no caller (CL-I1).
- **Usages.** CLIENT: BR-50 to BR-52.
- **Drift.** None.
- **Defects not to copy.** `monthCal` is dead code.

Two of the page-local charts now have their own ids (lane RECONCILE-LOOK, 27 September): the Local geo-grid (LR-W03) is DS-COMP-41 Rank grid and the true-scale funnel (FN-W02, `index.html:1005-1052`) is DS-COMP-40 Funnel chart. Still page-local: the Account segmented bar (AC-02, whose Outstanding segment and legend swatch differ in colour, CL-D5). The Funnel and Local tabs are hidden for the sample tenant and were not cropped. The video timeline with comment pins (R-06) is placeholder art.

## Page structure (continued)

### DS-COMP-31 Hero

- **Purpose.** The opening block of the client home and the weekly report: a greeting or headline with a few big figures.
- **Anatomy.** `.hero` > heading and lede > `.hero__stats` > `.hero__stat` × n.
- **Shot note.** At 1480 the hero crop is over the 40 KB cap even at scale 0.5, so only the 390 shots are kept. A whole-page capture, kept private, shows it wide.
- **Variants kept.** `home` (portal home); `report` (the weekly `.glance` override, `weekly-report/index.html:33-39`).
- **States.** None.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | home | default | 390 | (screenshot, kept private) (scale 0.5) | (screenshot, kept private) (scale 0.5) |

- **Construction.** `.hero` `app.css:6138-6153`; page-local override in the weekly report.
- **Styling (measured by lane RECONCILE-LOOK, 27 September, against FA-CLIENT-14 and FA-CLIENT-36).** `report`: the number `.hero__num` is Funnel Display `clamp(4.5rem, 15vw, 8rem)` (128 at 1480) 500, line .85, `--tracking-display`, tabular (`client-portal/reports/weekly-report/index.html:33-37`), the DR-7 exception. `home` on the Brief: 1168 × 273 at 1480 over the `--hero-paint` cover, with the Edit cover button top right. `home` on the portal (FA-PORTAL-17): eyebrow Chivo Mono 12/400 upper; name Funnel Display 49.6/500, tracking -1.488, with a 24 mark; stats Funnel Display 24 to 27.2/500 over Mono labels (the DR-7 exceptions).
- **Usages.** PORTAL: PH-03 to PH-06. CLIENT: BR-01, WK-10.
- **Drift.** The hero's figures are a fourth stat implementation (DS-COMP-6). Keep them here as the hero's own.
- **Defects not to copy.** None flagged.

### DS-COMP-32 Meeting card

- **Purpose.** The next meeting: kind, a mini calendar, the details and a primary action.
- **Anatomy.** `.mcal__kind` > mini calendar (`miniCal`) > `.mmeta` of `.mmeta__row` (With, Where, Link, Notes) > primary button `.mcal__cta`.
- **Variants kept.** One.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | meeting | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `meetingCard` `ui.js:2820-2835`; `.mmeta__row` `app.css:2137`.
- **Usages.** PORTAL: PH-08 to PH-12, PC-12. CLIENT: BR-13, BR-14 (with the name swapped on the client face).
- **Drift.** None.
- **Defects not to copy.** None flagged.

### DS-COMP-33 Source rows

- **Purpose.** Under a number, the list of sources that corroborate it, one line each.
- **Anatomy.** `.srcline` × n (source mark, name, value, status).
- **Variants kept.** One.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | source-row | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `sourceRows` `ui.js:1424`; `.srcline` `app.css:894`.
- **Usages.** WORKBENCH: WB SH-23, TL-W06, SS-W04, GA-W06, LR-W07, CL-W06, FN-W05.
- **Drift.** None.
- **Defects not to copy.** Source links to removed tabs are deleted, text and all (WB D10).

### DS-COMP-34 Journey map

- **Purpose.** The Activation map: a client's journey as stages on a line, a reader panel for the picked stage, and the operations under it.
- **Anatomy.** `.amap__intro` > `.amap__legend` (filter, DS-COMP-16) > `.amap__stage` of `.amap__node` × n > `.amap__reader` (3px left rule in the state colour) > `.amap__ops` > `.amap__roadlink`.
- **Variants kept.** One. It is column-like but not a board.
- **States.** Node default, hover, picked.
- **Styling.** Node: 193×100, grid, padding 12, gap 8; hover `--surface-2` (#f2f2f2 / #171619). Intro (added by lane RECONCILE-LOOK from FA-AGENCY-79): title Funnel Display `clamp(1.75rem, 3.1vw, 3.4rem)` (45.88 at 1480) 500, `--tracking-display`, line 0.98, max 19ch; lede `--text-muted` at `--text-sm`, max 42ch; a 1px dotted `--border-strong` rule under the block (`app.css:12734-12746`). The fluid title is outside the type scale: a hero-only exception, as DR-7 treats the portal hero.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | stage-line | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | node | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | node | hover | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | node | focus-visible | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | reader | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | legend-filter | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** `activationmap.js:137`; CSS `app.css:12733-12889` (legend `12760-12770`, reader `12782`, road link `12787`).
- **Usages.** AGENCY: AG-A4 to AG-A12.
- **Drift.** The reader's 3px rule is one of the five strip dialects (DS-COMP-5). Kept at 3px because it shows state (DR-9).
- **Defects not to copy.** The journey line strikes through the stage descriptions (AG D-A13). `↗` on an in-app door (D-A15).

## Cross-cutting and page patterns

### DS-COMP-35 Client face deltas

- **Purpose.** One list of what changes on each composite when the client, not the agency, is looking. The face is set by `body[data-face="client"]` and by `data-view="agency"` hiding agency-only content (`app.css:2688`, `4420-4421`).
- **Deltas by component.**

  | Component | Client face |
  |---|---|
  | DS-COMP-1 App strip | teal ground; tag "CLIENT PORTAL"; presence, timer and the dock hidden; search stays (PF-06, PF-07) |
  | DS-COMP-3 Page header | loses Edit and draft (PW-01, PM-01); Ask us in the meta (PP-03) |
  | DS-COMP-5 Strips | CTA strip added (PW-02, PM-02) |
  | DS-COMP-13 List row | asset row has no × (PLK-06); connection rows are remove-only (PAC-03, PAC-04); channel links become plain text (PF-08, PW-03) |
  | DS-COMP-15 Thread | edit own comments only (PP-19); voice composer has no "Who sees it" (PLV-07) |
  | DS-COMP-16 Filter bar | no Client or Assignee facets (PP-11) |
  | DS-COMP-17 and 18 | the board is replaced by split cards, with a stat row and a filter row (PORTAL §0.4, PP-05 to PP-12) |
  | Copy | second person throughout (PF-09) |
  | Agency-only content | Executive 005, Connections 006 to 012, WK-03 to WK-05, MO-13, the Design system library (DSY) |
  | Client-only content | WK-14, MO-04 |

- **Shots.** The strip variants are in DS-COMP-1. The split board is in DS-COMP-18.
- **Construction.** `portal.js:78-79` (face), `app.css:2688`, `app.css:4420-4421`, `app.css:2779-2781` (client mark).
- **Usages.** SHELL §4, SH-13, SH-16, SH-33; AGENCY AG-X20; PORTAL §0, PO-*; CLIENT WK-14, MO-04, VO-*, BR-13, MO-02, AC-02; WORKBENCH D30.
- **Drift.** Leaks in both directions: client-voiced copy and Ask us on the agency face (BOARDS D-24, D-25, D-26, M-06); hidden agency composites still in the client's DOM (PO-F1 to PO-F3); the workbench reachable on the client face (WB D30). All defects: drop.

### DS-COMP-36 Placeholder page

**Retired 27 September 2026 (AUDIT-RECONCILE, AS-16).** A mockup device, not a product page (R2 (a): an undesigned address is left out of the navigation and a typed address shows the one empty state, DS-PRIM-28); its 8 inventory rows and 13 fresh-audit rows now map to DS-PRIM-28. Kept below as evidence only; not built, and no page points here.

- **Purpose.** Holds an address and its sub-menu so a later port can replace the body without moving the page. The page itself is a mockup placeholder: each address it holds is a real page to build (`PLACEHOLDERS.md`, DS-COMP-36).
- **Anatomy.** Page header (DS-COMP-3 `placeholder`: title = route label, chip "PLACEHOLDER PAGE") > info notice (DS-COMP-5 `placeholder notice`: "<Label> is a placeholder in the mockup.") > section head with the parent's label (DS-COMP-4) > sibling door cards (DS-COMP-8), one per sibling, the current one marked `aria-current=page` > a "Port handoff" card with Canonical path, Mockup source and Layer.
- **Variants kept.** One. 21 addresses resolve to it (SHELL §5).
- **States.** None. Narrow widths stack as any page.
- **Styling.** Sibling card 1168×126, padding 24, as DS-COMP-7; no hover (see DS-COMP-8 drift).
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | page | default | 1480 | (screenshot, kept private) (scale 0.5) | (screenshot, kept private) (scale 0.5) |
  | page | default | 390 | (screenshot, kept private) (scale 0.7) | (screenshot, kept private) (scale 0.7) |

- **Construction.** `route-home/index.html:31-95` (header 31-39, sibling cards from the inline script 72-95).
- **Usages.** SHELL: SH-21, SH-40 to SH-44. AGENCY: AG-X1, AG-X7 to AG-X16. BOARDS: §5 `/projects/reviews/`, §7 `/inbox/`. CLIENT: DOC-01 to DOC-04, FM-01 to FM-04.
- **Drift.** A placeholder in a designed frame (content under `[data-unwired]`: G-01 to G-05, PG-01 to PG-04, PLD-01 to PLD-04) is a different thing: the frame is designed, the content is the hatch. Keep separate.
- **Defects not to copy.** The sibling grid uses `grid g-3`, which does not exist (only `.g3`), so the cards stack one per row at every width (SHELL D2). A direct load of `/route-home/` shows an empty rail and no tab row. `/dashboard/` is a placeholder (AG D-A19). A designed sibling is labelled "Open placeholder page" (I3).

### DS-COMP-37 Report layouts

- **Purpose.** The page frames of the client reports.
- **Variants kept.**
  - `weekly glance`: an 880-wide column (`weekly-report/index.html:20`) with the report hero (DS-COMP-31).
  - `monthly chapters`: a 940-wide `.report` of chapters with `.chapter__title` at Display 36 and chapter edit bars (`.chedit`, `app.css:1915`) (`monthly-report/index.html:20-42`).
  - `narrow page`: `.content--narrow` at 960 (Track record).
- **Shots.** None in this lane; whole-page captures are in `.local/mockup-inventory-2026-09-26/captures/CLIENT/weekly/`, `monthly/`, `track-record/`.
- **Usages.** CLIENT: WK-*, MO-* (MO-03 cover, MO-12 caveats), TR-*.
- **Drift.** Three widths for one job (880, 940, 960). Ruled (DR-52): one report width, 960 (`.content--narrow`). The monthly header is `.noprint` in full.

---

### DS-COMP-38 Calendar and date grid

Added 27 September 2026 by lane CROSSCHECK (the Astra cross-check, `../ASTRA-CROSSCHECK.md`). It closes the catalogue's own known gap: PRIMITIVES handed the date grid, the week strip and the slot grid to COMPOSITES, and none had an id.

- **Purpose.** Pick or read a day and a time: the date picker's month grid, the next meeting's week strip, and the booking page's day list, time slots and meeting-type tiles.
- **Anatomy.** A head (month name, Sans .875rem/500; previous and next buttons 1.6rem square with a 1px `--border`) over a seven-column weekday row (Mono 12, `--text-muted`) and a grid of day cells; an optional quick-date row (Mono 12 chips on a `--border` top rule). The booking form uses the same cell language as a list of days and a grid of slots.
- **Variants kept.**
  - `date picker grid` (`.dp__pop` > `.dp__head`, `.dp__dow`, `.dp__grid` of `.dp__day`, `.dp__quick`): seven 1.9rem columns, 2px gap, cells 1.9rem tall, Sans .8rem tabular. The pop itself is DS-PRIM-19's date-picker placement (accent border, `--shadow-overlay`, z 40, `aa-drop` 220 ms).
  - `week strip` (`.mcal`, `miniCal`): seven equal columns, 2px gap; each day a weekday (Mono 12) over a number (1rem tabular). Hosted by DS-COMP-32 Meeting card.
  - ~~`day list`~~ (`.day`): retired 27 September (AS-11, R27): the portal's old booking page is replaced by the one booking card, which picks the day with a select.
  - `slot grid` (`.slot`, `.bk__grid`): three columns (two at ≤ 640), Mono .8rem centred cells.
  - ~~`meeting-type tile`~~ (`.mtype button`): retired 27 September (AS-11, R27): the one booking card picks the kind with a select.
- **States.** Out of month (`--text-muted` at opacity .55); weekend (`--text-muted`); today (an underline, never a fill; in the week strip a 1px `--border-strong` rule under the number); selected or pressed (1px `--accent` border plus the 8% accent wash on day cells; `--surface-2` on slots; an inset 2px accent left rule on the day list); the meeting day in the week strip (accent border, 8% wash, accent weekday); hover (`--border-strong` on day cells, `--accent` on booking cells); a slot with no availability (`disabled`, opacity .4, struck through, `not-allowed`).
- **Styling.** Grounds `--bg` (pop), `--surface` (booking cells); borders `--border`, `--border-strong`, `--accent`; wash DS-TOK-26 `--accent-wash` (DR-11); radius 0; type DS-TOK-120 and DS-TOK-124 families as above.
- **Shots.** The open date picker is not cropped yet (known gap: it needs a task or board cell editor opened first).

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | week-strip | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | day-list | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | slot-grid | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | meeting-type | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** Date picker `assets/portal.js:896-990`, CSS `app.css:2384-2440`; week strip `miniCal` `ui.js:2721-2819`, `.mcal` `app.css:2099-2125`; booking page `client-portal/contact/book/index.html:17-38`; booking popover grid `.bk__grid` `app.css:3322`, `.bk__slotpop` `app.css:3347`. `monthCal` (`ui.js:8160`) has no caller: a month calendar is not drawn anywhere and is not part of this entry.
- **Usages.** TASKS: DP-20b (the grid; DP-20a, DP-20c, DP-20d stay on their controls). PORTAL: PH-10 (week strip inside the meeting card); PB-04 (meeting-type tiles), PB-06 (day list), PB-07 (slot grid), retargeted from DS-PRIM-10 by lane RECONCILE-LOOK because this entry names those classes as its variants. CLIENT: BR-21 (slot grid).
- **Drift.** Two selected treatments for one meaning (wash on day cells, `--surface-2` on slots, a left rule on the day list); keep them as placements only if the owner's DR-28 pressed looks are read to cover them, otherwise snap to the accent border plus wash.
- **Defects not to copy.** The selected day carries `aria-current="date"` even when it is not today, and a day button's accessible name is only its number (`portal.js:975-982`); give each day a full date label and keep current-date semantics for today. No arrow-key movement; counts from the real clock (TASKS D-34).

### DS-COMP-39 Media tile

Added 27 September 2026 by lane CROSSCHECK. `PAGE-MAP.md` had mapped the gallery to the card with the note "no media tile component, closest is card".

- **Purpose.** Stand in for a photo, video or ad creative until the real asset exists, and hold it once it does.
- **Anatomy.** A fixed-ratio box with a 1px `--border` and a label; the scene variant paints a two-stop gradient with a dark foot scrim and a white Mono label.
- **Variants kept.**
  - `gallery tile` (`.gtile`): 4:3; `linear-gradient(150deg, var(--a), var(--b))` from the client's brand stops, a scrim of black 45% rising to transparent at 55%, label Mono .62rem white at .45rem .55rem. Four across, two at ≤ 900 (`.gallery`).
  - `creative art` (`.creative__art`): 4:5 on `--surface-2`, a centred Mono 12 label in `--text-muted`; it heads a creative card whose metric rows sit beneath, in a sideways-scrolling row of 190px columns (`.creatives`).
- **States.** Placeholder (label only) and filled (the asset). No hover of its own; a linked tile takes the host's link treatment.
- **Styling.** Scene paint is client content (the gradient stops come from the client, like DS-COMP-31 Hero), not product colour; label ink white in both themes, as the hero's (`--on-dark`, DS-TOK-16). Radius 0.
- **Shots.**

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | gallery-tile | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | creative-art (whole creative card) | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |

- **Construction.** the `client-portal/home` page's `index.html:28-36` (CSS), `:263` (host), `:378-379` (render); `client-portal/channel-workbench/index.html:19-25` (CSS), `:1531-1533` (render).
- **Usages.** PORTAL: PH-19 (gallery tiles). WORKBENCH: MA-W03's creative cards (the carousel row itself stays DS-COMP-7). Built on inside a DS-COMP-7 host, added by lane RECONCILE-LOOK from the fresh audit: the Brand hero photo and video tiles, CLIENT BD-06 and PORTAL PLB-08 (FA-CLIENT-56, FA-PORTAL-76).
- **Drift.** Both variants are page-local styles today; the build gives them one component with a ratio prop.
- **Defects not to copy.** The label is hard-coded `#fff` (use `--on-dark`).

---

### DS-COMP-40 Funnel chart

Added 27 September 2026 by lane RECONCILE-LOOK from the fresh audit (FA-WORKBENCH-86). `CATALOGUE.md` had mapped it to DS-COMP-29 as the nearest fit ("page-local charts"). It is not an inline chart, so it gets its own home.

- **Purpose.** A conversion funnel drawn to true scale: each stage as wide as its count, from the first stage down, with the stage conversion beside it.
- **Anatomy.** `.funnel` > `.funnel__step` × n, each a row of label (`.funnel__label`, 500) · shape track (`.funnel__shape` > `.funnel__bg`, a centred trapezoid whose top edge is this stage's width and bottom edge the next's) · values (`.funnel__val`: count, `.funnel__pct` in Mono, ▲/▼ points markers) > `.funnel__foot` (one Mono sentence with the end-to-end rate).
- **Variants kept.** `shape` (`.funnel--shape`, the silhouette, stages fused edge to edge); `bars` (the plain stepped rows, `.funnel__bg` as a left-anchored bar); a `context` step (`.funnel__step--ctx`, for example sessions above enquiries, painted at accent 6%).
- **States.** None of its own. At ≤ 640 the shape track hides and the row is label and values only.
- **Styling.** Step: min-height 48 (`3rem`), padding 0 16, columns `8.5rem 1fr 16rem` in the shape variant; fills are stepped accent tints from 12% to 56% (context 6%), deepening down the funnel; percentages and foot Mono `--fs-mono-sm` `--text-muted`; values tabular. Radius 0.
- **Shots.** Added at build-ready (27 September 2026). The Funnel tab is hidden for every tenant in the mockup, so the crop loads the workbench page without its source-availability pruning (the harness re-renders the page's own code; nothing in the mockup was edited). At 390 the shape track hides, as States says: label and values only.

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | shape | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | shape | default | 390 | (screenshot, kept private) | (screenshot, kept private) |
- **Construction.** `app.css:381-422`; built in `client-portal/channel-workbench/index.html:946`, `:1029-1031` (`funnelClip`).
- **Usages.** WORKBENCH: FN-W02.
- **Drift.** None seen elsewhere.
- **Defects not to copy.** None found.

### DS-COMP-41 Rank grid

**Retired 27 September 2026 (AUDIT-RECONCILE, OP-23, AS-15).** C27 local rank geo-grid is out of scope (the owner, 27 September, `research/LOCAL-RANK-GRID.md`; CS-13.36); LR-W03 maps to `content` (dropped). Kept below as evidence only; not built, and no page points here.

Added 27 September 2026 by lane RECONCILE-LOOK from the fresh audit (FA-WORKBENCH-79); previously mapped to DS-COMP-29 as the nearest fit.

- **Purpose.** Where a business ranks across a map area: a 5 × 5 grid of sample points, each showing the local rank there.
- **Anatomy.** `.geogrid` (5 columns, gap 4, max 260 wide) > `.geogrid__cell` × 25 (round, the rank in Mono) > a legend of the three bands beneath.
- **Variants kept.** One.
- **States.** None. Band colour by rank: top 3, 4 to 10, 11 and over (status colours as text and ring, never a fill, per the house rule).
- **Styling.** Cell: square ratio, radius 50%, 1px `currentColor` ring, Chivo Mono 12 (`.75rem`), centred.
- **Shots.** Added at build-ready (27 September 2026), the grid only (the legend beneath is not in the crop); reached the same way as DS-COMP-40, since Local & reviews is hidden for this client.

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | grid | default (all three bands) | 1480 | (screenshot, kept private) | (screenshot, kept private) |
- **Construction.** `client-portal/channel-workbench/index.html:27-30` (CSS, page-local), card at `:809`.
- **Usages.** WORKBENCH: LR-W03.
- **Drift.** It is page-local CSS; retired, so the build does not move it anywhere.
- **Defects not to copy.** None found.

## Rulings, decided

Each was a drift the lane thought might be intended. All are ruled (26 September 2026, the `DR` triage on #297's map) and written into their entries above. Cite the `DR` id, never the lane label: these `R1` to `R19` collide with `TICKET-PLAN R<n>`.

| # | Component | Question | Default in this file | Ruled |
|---|---|---|---|---|
| R1 | DS-COMP-3 | Two title insets (x 272 on designed client pages, 256 elsewhere): keep both? | One inset | DR-39 (decided): one page-title inset, 256 (R1). |
| R2 | DS-COMP-3 | Portal Connections has no in-page title and Book has no sync marker: intended? | Follow the page as drawn | DR-40 (decided): as drawn, no title on Connections, no sync marker on Book (R2). |
| R3 | DS-COMP-4 | Monthly chapter titles at Display 36 and Weekly bare u-tag heads: a report variant, or the numbered head? | Keep as a report variant | DR-41 (decided): report variant of the section head (R3). |
| R4 | DS-COMP-5 | `.chanflag` and `.draftgate` use a 3px rule to mark a state: keep 3px, or 2px like every strip? | 2px | DR-9 (decided): 3px = state rule, 2px = tip/flagged card; all four drawn 3px rules stay (as drawn; DIRECTION task page). |
| R5 | DS-COMP-7 | Verdict strip and attention feed carry a stronger `--border-strong` outline than a card: keep? | Keep | DR-42 (decided): keep `--border-strong` on verdict strip and attention feed (R5). |
| R6 | DS-COMP-8 | `a.card--interactive` lifts on hover; other doors only change border: lift everywhere, or nowhere? | Nowhere | DR-2 (decided): border-only hover, no lift (both lanes; one hover rule). |
| R7 | DS-COMP-13 | Notification rows wash accent 6% on hover (unread feel) where other rows use `--surface-2` | Keep the accent wash for notices only | DR-43 (decided): notices hover with `--accent-wash` (8%); other rows `--surface-2` (R7). |
| R8 | DS-COMP-13 | Three fold rules for long lists (fold at 8, page by 10, no fold) | One rule, to be chosen | DR-44 (behaviour): long lists fold at 8 / ledgers page by day, tracked per list type (R49); do not copy the whole 170-row ledger. |
| R9 | DS-COMP-15 | Two chat renderers (people thread against assistant bubbles) | Keep both | DR-45 (decided): people thread and assistant bubbles kept as named variants (R9). |
| R10 | DS-COMP-16 | The Activation map's legend doubles as a status filter where other pages use facets | Keep the legend filter there | DR-46 (behaviour): legend click filters the Activation map by status, tracked in the page's filter state. |
| R11 | DS-COMP-16 | CRM board actions on a second line | Keep | DR-47 (decided): CRM board actions stay on a second line (R11). |
| R12 | DS-COMP-17 | Row height 39 (projects) against 43 (CRM), name 400 against 500 | One height, one weight | DR-48 (decided): board rows 39 tall, names 400 (Projects board; R12). |
| R13 | DS-COMP-18 | Review cards go to one column at ≤900 on the agency twin and at ≤1279 on the portal | One breakpoint | DR-49 (decided): review cards go single column at ≤ 900 on both faces (R13). |
| R14 | DS-COMP-21 | The AI head's close rotates 90° at ≤900 (bottom sheet) | Keep only in the sheet | DR-3 (decided): one panel head per WIRING section 34.3 for every panel incl. the assistant; X hovers `--text`, no rotate; Close all stays red. |
| R15 | DS-COMP-26 | Voice note form has no tinted block | Tinted block | DR-50 (decided): voice note form gets the tinted block (R15). |
| R16 | DS-COMP-29 | Response-time sparkline drawn without an area | Area on | DR-51 (decided): sparkline area on everywhere (R16). |
| R17 | DS-COMP-34 | The Activation map reader's 3px state rule | Keep (it shows state) | DR-9 (decided): 3px = state rule, 2px = tip/flagged card; all four drawn 3px rules stay (as drawn; DIRECTION task page). |
| R18 | DS-COMP-37 | Report widths 880, 940 and 960 | One width, to be chosen | DR-52 (decided): one report width, 960 `.content--narrow` (R18). |
| R19 | DS-COMP-25 | There is no modal: are inline confirms the house pattern, or should a modal exist? | Inline confirm | DR-53 (decided): inline confirm, no modal (the owner's alert ruling WIRING.md:3567; R19). |

## Handed to other lanes

- **PRIMITIVES:** the banner strip itself (DS-PRIM-22), buttons (DS-PRIM-1) and the head-button component asked for by DOCK D-26 (DS-PRIM-2; the dock's is DS-SIDE-9), chips and pills (DS-PRIM-11), the face-switch segmented control and the facet (DS-PRIM-10), inputs (DS-PRIM-3) and the house select button (`.sel__btn`, DS-PRIM-5), the meter (DS-PRIM-23), the freshness marker as a button (DS-PRIM-25), door marks (DS-PRIM-17), tooltips (`.term`, `.oncal__pop`: DS-PRIM-18), the three empty-state classes (`.dp__empty`, `.tl__none`, `.crm__none`) and the other five empty dialects (DS-PRIM-28), the `.table` primitive inside cards (DS-PRIM-20).
- **SIDEBAR:** the left rail and its drawer (SH-1 to SH-9, SH-23, SH-24, SH-30, SH-31), the dock edge rail and tabs (SH-25, SH-26, DK-01 to DK-07, DK-14, DK-15, NT-01), panel slide, width, seating and stacking, the AI bottom sheet geometry at ≤900.
- **TASK-PAGE:** the task panel head and body (TASKS DP-01 to DP-35, DT-01 to DT-23, DA-01 to DA-10, DN-01 to DN-05), the task page (TP-01 to TP-12, TT-01 to TT-06, TA-01 to TA-12, TG-01 to TG-09, TASKS TM-01 to TM-04), the task sideboard `.sb` and its activity strip `.sbact`, `.tph__stat`, and the task list rows seen in BOARDS P-49, R-09, M-08.
