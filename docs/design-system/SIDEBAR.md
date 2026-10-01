<!-- Public edition, generated from the private design-system source by ticket C82's build and checked by the real-names check before it crossed. Do not edit it here; the source changes and the copy is run again. Screenshots and review records stay private, so they are not linked. -->

# The sidebar: specification

This is the canonical home for the Ops Astro sidebar. It answers to `DIRECTION.md` point 4: *"i do really like the way that the sidebar works so if you could kind of document the different states and the way that it slides out ... i really want you to nail the sidebar"*.

Written 26 September 2026 by lane SIDEBAR (design-system pass, wave 1, Opus 5.5). Plan and document only: nothing in `dashboard-mockups` was changed. Amended 27 September 2026 by lane CROSSCHECK against the blind Astra review (`ASTRA-CROSSCHECK.md`): print, the sheet-drag detail, D17 to D19, T-D24a and DR-64. Amended the same day by lane RECONCILE-LOOK against the fresh capability-first audit (`evidence/RECONCILE-LOOK.md`): the strip order on DS-SIDE-6 and defects D20 to D22. Amended the same day by lane ANSWERS24 on the owner's answers: DR-64 ruled (owner answer 8), T-D19 rewritten, and the note amending WIRING §34.4 under DS-SIDE-7 drift.

**How to read it:**
- Source is `dashboard-mockups`, cited as `file:line` (measured 26 September 2026). The mockup code is evidence of intent, not clean code.
- Shots are under `shots/sidebar/DS-SIDE-<n>/`, named `<variant>-<state>-<width>-<theme>.png`. Motion is under `shots/sidebar/DS-SIDE-<n>/motion/`: a contact strip (`*-strip.png`, every 40 ms from 0 to 600 ms, slowed ten times) and four key frames (`f000-0000ms`, `f003-0120ms`, `f006-0240ms`, `f015-0600ms`).
- Token names come from the crop tool's matcher, which reads every stylesheet including `hub-ds/*.css`. Where the matcher lists aliases, the first meaningful one is given. Light / dark values are given as `light / dark`.
- Motion tokens: `--ease` = `cubic-bezier(0.16, 1, 0.3, 1)`, `--dur-fast` 120 ms, `--dur-1` 220 ms, `--dur-2` 420 ms (`hub-ds/radius.css:44-50`).
- Primitives are cited by name only (DS-K1 `.btn`, DS-K11 callout dialect, DS-F1 focus ring and so on, from `docs/mockup-inventory/SHELL.md` section 1). Their full entries belong to the primitives catalogue.

**How to read behaviour in this file** (DIRECTION.md point 6): the look is canonical, and so is the sidebar's behaviour where the owner stated it as law: the operating laws in WIRING §34 (the owner, 30 July 2026, "this is the way the sidebar works"), the gesture law (§34.2), the persistence and pre-paint law (§34.4) and every state, motion, timing and easing measured here, with the tests T-D1 onwards restating them. Those are specified exactly. Where this file describes how the mockup implements a behaviour (its storage keys, event listeners, handlers), that is evidence of intent: the build keeps what the law requires, not the key or the listener. Any other control's capability is listed in [`PLACEHOLDERS.md`](PLACEHOLDERS.md) under its DS-SIDE id. Bugs ("Defects found") are never copied.

---

## Which edge is "the sidebar": decided

The owner means **the dock**: the right edge rail and its sliding panels. Evidence: WIRING §34 is headed "THE SIDEBAR'S OPERATING LAWS" (`WIRING.md:2162`, the owner 2026-07-30, "this is the way the sidebar works"), and on 7 August they said "I want the sidebar dock to be the first thing that's ported across" (`WIRING.md:8376`). Recorded on ticket #298 ("Which edge is 'the sidebar'", closed).

Both edges are still documented, because they share one motion (the shell's `grid-template-columns` over 420 ms, `--ease`) and one rail dialect. **Part 1 is the dock, the reference to match exactly** (DS-SIDE-1 to DS-SIDE-10). **Part 2 is the left navigation rail** (DS-SIDE-11 to DS-SIDE-19).

Rulings already decided on ticket #303 and cited here rather than raised again:
- **R33:** below 900 the dock stays a visible tab strip plus one sheet panel.
- **R34:** only panels with a body get a door.
- **R36:** opening a panel never clears a count.
- **R37:** hover-only controls show at rest below 900.
- **R38:** a second click on an open record means nothing new.
- **R39:** the 380 floor holds. A third panel that cannot fit closes the lowest-ranked panel, with a one-line stamp.

---

## Shared shell geometry (both parts)

- `.shell` is one CSS grid: `var(--rail-w, 224px) 1fr`, plus a third track `var(--dock-w, 40px)` on the agency face (`app.css:141`, `:4417`, `:4598`, `:4602`, `:5845`).
- **The one motion:** `body.dock-ready .shell { transition: grid-template-columns var(--dur-2) var(--ease) }` (`app.css:4856`). `dock-ready` is added two animation frames after load, with a 400 ms timer as a fallback (`dock.js:338-345`). Nothing animates on first paint.
- **Reduced motion:** `app.css:4857-4859` sets that transition to none. The global fallback sets every duration to 0.001 ms (`hub-ds/base.css:80-82`, `hub-ds/primitives.css:753-761`).
- **Print:** both edges leave the page. The left rail, the AI panel, the backdrop and the hamburger are `display: none` (`app.css:617-625`), the shell drops to one column (`:4604-4606`), the railmark hides (`:2296`), the shell transition is off (`:4891`), and the sheet tier's grid, scroller and bottom reservation are unwound and the dock itself is `display: none` (`:6059-6070`). (Added by the Astra cross-check, `ASTRA-CROSSCHECK.md`.)
- **The pre-paint hook** is the first child of `<body>` on every shell page (`route-home/index.html:17-18`; 25 pages carry it). Before first paint it applies the theme, the face, `body.rail-collapsed` with `--rail-w: 56px` (or `--rail-w` from `aa-rail-w`), `dock-open`, `ai-dock` and `--dock-w`. The page's scripts are `blocking="render"` (`dashboard/index.html:11-13`), so the first paint waits for them. WIRING §34.4 makes this a law: any stored layout preference must be replayed here or it causes a one-frame jump.

### Breakpoints that change the sidebar

| Threshold | Defined at | Left rail | Dock |
|---|---|---|---|
| ≤ 640 | `hub-ds/breakpoints.css` | No change | No change |
| ≤ 900 | `app.css:634`, `:2241`, `:4515`, `:6027`; pre-paint `matchMedia('(max-width: 900px)')` | Becomes an off-canvas drawer, `min(300px, 84vw)` wide. Fold and grip hidden (`:1472`). Hamburger shown (`:655`). | Fixed to the bottom. The tab strip is a 40 px row that is off screen while nothing is open (defect DS-SIDE-D9). Only the last open panel draws (`dock.js:219`, `:794`). |
| 901 to 1279 | `@media (900px < width <= 1279px)` `app.css:5853-5956`; `dock.js:145-146` | Spans both grid rows (`:5879`). | **Sheet tier:** the dock sits under the content in grid row 2. Panels stack vertically. A horizontal tab strip replaces the side rail (`:5948`, `:5974-6001`). |
| ≥ 1280 | `not all and (max-width: 1279px)` `app.css:5844` | Normal. | Side rail on the right edge. |
| ≥ 1440 | `min-width: 1440px` `app.css:4601`; `dock.js:123`; pre-paint | Normal. | A panel may **seat** (take a grid track). Below 1440 it always floats. |
| Seat line (computed) | `dock.js:255-275`; pre-paint | Its width feeds the dock's maths. | A panel group seats only when `n × per ≤ vw − rail − 40 − 836`. One 550 px panel seats from **1650** with a 224 px rail, and from **1482** with the rail collapsed to 56. Two panels seat from **2200**. |

---

# Part 1: the dock (the right edge rail and its panels), the reference

The dock is the mechanism in `assets/dock.js` and the residents in `assets/dockboot.js`. Its laws are WIRING §34 (2026-07-30) with the §34.7 amendment (2026-08-12) and the history mechanism in §107. The panels' contents belong to `docs/mockup-inventory/DOCK.md` (CL, CR, DC, BM, PJ, TM, NT, AI ids) and `TASKS.md` (DP, DT ids); this part covers the frame they sit in.

## DS-SIDE-1 Dock edge rail

- **Purpose.** A fixed strip of permanent doors, one per panel (§34.1: "the edge is a PLACE").
- **Anatomy.** `nav.dock__rail[aria-label="Side panels"]` > `button.dock__tab` × 8 in `ORDER` (`dock.js:188`): Client intelligence (`ai`), Notifications (`notifs`), Team, Clients, Projects (`todos`), Task, Bookmarks (`marks`), Docs (`notes`). The first tab has a divider under it (`.dock__raildiv`, 18 × 1, `--border-strong`, drawn only when a tab sits below it, `dock.js:687-700`). Close all (DS-SIDE-5) sits at the foot when anything is open.
- **Variants kept.** Side rail (≥ 1280), sheet strip (901 to 1279, DS-SIDE-6), bottom strip (≤ 900).

**States**

| State | Look |
|---|---|
| At rest (1280 and up) | 40 wide, padding 8 0, gap .15rem; `--rail-bg`; 1 px `--border` on three sides (none on the right); `--shadow-sm` (`rgba(15,18,24,.05) 0 1px 2px` / `rgba(0,0,0,.45) 0 1px 2px`). Vertically centred on the right edge (`margin: auto 0; height: fit-content`), placed at `left: -40px` of `.dock__panels`, z 45 (`app.css:4435-4439`, `:4641-4651` overridden by `:4966-4969`). 286 tall at rest. |
| A panel open | The shadow is removed (`app.css:5628`), Close all is added (324 tall), and the rail rides the panel group's left edge. |
| Between 1440 and 1649 | The rail never takes a grid track (`dock.js:203-210`), and a panel floats. |
| Sheet tier | The side rail is hidden (`app.css:5948`); DS-SIDE-6 takes over. |
| ≤ 900 | A 40 px row, `order: 2`, under the panel (`app.css:4520`, `:6048-6052`). With nothing open it is off screen (DS-SIDE-D9). With a panel open it shows under the panel (the phone shot). Decided (R33, #303): below 900 the strip stays visible, with one sheet panel. |
| Client face | The whole dock is hidden (`data-view="agency"`, `app.css:4420-4421`; PORTAL.md PF-07). §34.6: reaching the client face is a ruling, not a default. |

| Variant / state | Light | Dark |
|---|---|---|
| At rest, 1480 | `shots/sidebar/DS-SIDE-1/at-rest-default-1480-light.png` | `shots/sidebar/DS-SIDE-1/at-rest-default-1480-dark.png` |
| Panel open, 1480 (floating) | `shots/sidebar/DS-SIDE-1/panel-open-default-1480-light.png` | `shots/sidebar/DS-SIDE-1/panel-open-default-1480-dark.png` |
| Panel open, 1700 (seated) | `shots/sidebar/DS-SIDE-1/panel-open-default-1700-light.png` | `shots/sidebar/DS-SIDE-1/panel-open-default-1700-dark.png` |
| Bottom strip at 390, panel open | see DS-SIDE-7 `phone-default-390-*.png` | |

- **Construction.** `dock.js:449-524` (frame), `:489` (rail), `:687-700` (divider); `app.css:4429-4454`, `:4641-4651`, `:4966-4969`, `:5628`.
- **Usages.** SHELL.md SH-25. DOCK.md DK-01, DK-04.
- **Drift.** §34.1's spoken rail order has seven names and no Notifications; `ORDER` has eight (DOCK.md; §34.1 is stale). Keep `ORDER` as it is, and update the law's list (DR-59: CI, Notifications, Team, Clients, Projects, Task, Bookmarks, Docs).
- **Defects not to copy.** DS-SIDE-D9, D20 and D21 (the ≤ 900 row: overflow at 390, divider on the wrong axis), D22 (strip order), and dead CSS (`app.css:4460`, `:4641-4651`, `:5614`).

## DS-SIDE-2 Dock tab

- **Purpose.** The permanent door to one panel.
- **Anatomy.** `button.dock__tab[data-dock-tab=<id>][aria-expanded][aria-label="Open <Label>" | "Close <Label>"]` > `i.fi` glyph 16 px + `span.dock__tablabel` callout (DS-SIDE-3) + optional count chip (DS-SIDE-4).
- **Variants kept.** Standard tab (30 × 30); first tab (Client intelligence, 30 × 36 with 5.6 px bottom padding above the divider).

**States**

| State | Look (light / dark) |
|---|---|
| Idle | `--text-muted` `#8c857f` / `#f8f8f8` at 55 percent (DR-10 fold; the mockup drew 46); no fill |
| Hover | `--text` `#000` / `#f8f8f8` on `--surface` `#fff` / `#0f0f12`, and the callout shows (`app.css:4447`) |
| Focus-visible | The global ring DS-F1, and the callout shows (`app.css:5006`) |
| On (`.is-on`, `aria-expanded="true"`) | `--accent` `#745cee` ink, plus a 2 px accent line on the left edge (`left: -1px`, top and bottom 4 px) (`app.css:4450-4454`). In the sheet strip and at ≤ 900 the line moves to the top edge (`:6004-6006`, `:4521`). |
| Transition | `color` and `background` over 120 ms (`--dur-fast`), `--ease` (`app.css:4445`) |

| Variant / state | Light | Dark |
|---|---|---|
| Tab: default, hover, focus-visible, on | `shots/sidebar/DS-SIDE-2/tab-{default,hover,focus-visible,on}-1480-light.png` | `shots/sidebar/DS-SIDE-2/tab-{default,hover,focus-visible,on}-1480-dark.png` |
| First tab (AI): default, on | `shots/sidebar/DS-SIDE-2/first-tab-ai-{default,on}-1480-light.png` | `shots/sidebar/DS-SIDE-2/first-tab-ai-{default,on}-1480-dark.png` |

- **Click and keyboard.** See the gesture law (T-D1 to T-D5). Native button: Tab reaches it, Enter and Space press it. There are no shortcuts.
- **Construction.** `dock.js:361-371` (click), `:384-385`, `:393` (ARIA); `app.css:4440-4454`.
- **Usages.** SHELL.md SH-25. DOCK.md DK-02. NT-01 (the bell tab's title carries the count).
- **Drift.** None within the dock. Its hover matches the rail fold (DS-SIDE-15).
- **Defects not to copy.** No `aria-controls` anywhere, and `section.dpanel` has no accessible name (`dock.js:561-562`).

## DS-SIDE-3 Dock tab callout

- **Purpose.** Name an icon-only tab.
- **Anatomy.** `span.dock__tablabel[aria-hidden]` inside the tab.
- **Styling.** The tooltip dialect (DS-K10 / DS-K11): `--void` ground, `--on-dark` ink, Sans .78rem (12.5 px), padding .35rem .6rem, max 14rem, 7 px to the left of the tab, z 80, radius 0 (`app.css:4996-5008`).
- **States.** Shown on the tab's hover and focus-visible, by `display` only: no fade. It flips to the right of the tab when the rail's left edge is under 150 px from the window (`dock.js:300-301`, `app.css:5020`). It sits above the tab at ≤ 900 (`:5010-5015`) and in the sheet strip (`:6013-6018`).

| State | Light | Dark |
|---|---|---|
| Shown (tab hovered) | `shots/sidebar/DS-SIDE-3/callout-hover-1480-light.png` | `shots/sidebar/DS-SIDE-3/callout-hover-1480-dark.png` |

- **Construction.** `dock.js:631`; `app.css:4990-5020`.
- **Usages.** SHELL.md SH-25, DS-K11. DOCK.md DK-03.
- **Drift.** The same dialect as the page tooltip `.term` (DS-K10). One tooltip primitive (handed to PRIMITIVES).

## DS-SIDE-4 Dock count chip

- **Purpose.** A derived, uncapped count on a tab (§34.5). The build derives it from real, tracked records (`PLACEHOLDERS.md`, DS-SIDE-4).
- **Anatomy.** `span.dock__n`, pinned at `right: -3px; top: -3px`.
- **Styling.** 17 × 16 (1rem minimum), fill `--accent` `#745cee`, ink `--accent-ink` / `--on-dark` `#f8f8f8`, Chivo Mono 10 / 10, padding 0 2.4, square (`app.css:6423-6452`). The same in both themes.
- **States.** Absent at zero. Never capped ("12", not "9+").

| State | Light | Dark |
|---|---|---|
| Count 12 | `shots/sidebar/DS-SIDE-4/count-default-1480-light.png` | `shots/sidebar/DS-SIDE-4/count-default-1480-dark.png` |

- **Construction.** `dock-notifications.js:316-326`, `dock-team.js:152-165`; `app.css:6423-6452`.
- **Usages.** SHELL.md SH-26. DOCK.md DK-05, NT-01. §34.5 names its siblings `.tmc__u` and `.cl__n`: one "count chip" component (handed to PRIMITIVES, with this as the dock variant).

## DS-SIDE-5 Close all

- **Purpose.** Close every open panel at once.
- **Anatomy.** `button.dock__closeall[aria-label="Close all panels"]` > `.dock__raildiv` hairline + `fi-rr-cross-small`, with the callout "Close all".
- **States.** Hidden when nothing is open. Idle `--text-muted`; hover `--danger` (`#e84a5f` / `#f87171`); focus-visible global ring. Colour over 120 ms (`app.css:4724-4730`).

| State | Light | Dark |
|---|---|---|
| Default, hover, focus-visible | `shots/sidebar/DS-SIDE-5/closeall-{default,hover,focus-visible}-1480-light.png` | `shots/sidebar/DS-SIDE-5/closeall-{default,hover,focus-visible}-1480-dark.png` |

- **Construction.** `dock.js:507`; `app.css:4724-4730` (supersedes `:4666-4673`).
- **Usages.** DOCK.md DK-06.
- **Drift.** It hovers red; the panel X (DS-SIDE-9) hovers to `--text`, and the AI panel's close hovers to `--accent`. Three hover colours for "close": ruled by DR-3 (one head and one close hovering to `--text`, no rotate; Close all stays red).

## DS-SIDE-6 Sheet tab strip

- **Purpose.** The dock's rail turned 90 degrees for the 901 to 1279 tier (§34.4: "the same laws turned 90°").
- **Anatomy.** `div.dock__sheettabs[role="tablist"][aria-label="Side panels"]` of the same tab buttons plus Close all, centred on the sheet's top edge.
- **Styling.** 321 × 43, padding 12 12 0, `--rail-bg`, 1 px `--border` on three sides (none at the bottom) (`app.css:5974-6001`). The on line sits on the tab's top edge.
- **States.** Shown only in the sheet tier (`dock.js:408-442`, `:410`).
- **Order (added by lane RECONCILE-LOOK, 27 September, from the fresh audit FA-DOCK-30 to FA-DOCK-35).** Left to right, the tabs run in the rail's order, top to bottom: Client intelligence first, Docs last, then Close all (WIRING §27: the strips are "the rail rotated, same order"; the rail order is DR-59). The mockup sorts this strip by panel rank instead (`dock.js:416-419`), which puts Docs first, the reverse of the phone strip: DS-SIDE-D22, not copied.

| State | Light | Dark |
|---|---|---|
| Panel open, 1100 | `shots/sidebar/DS-SIDE-6/sheet-strip-default-1100-light.png` | `shots/sidebar/DS-SIDE-6/sheet-strip-default-1100-dark.png` |

- **Usages.** DOCK.md DK-07.
- **Defects not to copy.** It is `role="tablist"`, but its children are plain buttons without `role="tab"` (`dock.js:465`). DS-SIDE-D22 (the order).

## DS-SIDE-7 Dock panel

- **Purpose.** A place beside the page: one resident (Team, Projects, Task and so on) with a permanent door.
- **Anatomy.** `section.dpanel` > `.dpanel__head` (DS-SIDE-8) + `.dpanel__body` + `.dpanel__grip` (DS-SIDE-10), inside `.dock__panels` > `.dock__stack` (a flex row) (`dock.js:561-605`; `app.css:4466-4482`, `:4665`).
- **Variants kept.** Floating, seated, stacked (seated or floating), sheet, phone. The Task panel's empty draft is the empty-state rule's example (§34.1).

**States**

| State | When | Look |
|---|---|---|
| Floating | < 1440, or when the group does not fit the seat line | `position: fixed; top: var(--app-strip); right: 0; bottom: 0` (`app.css:4827`), shadow `--shadow-overlay`, over the page. Width `min(want, vw − rail)` (`dock.js:281`). 550 × 955 at 1480. |
| Seated | ≥ 1440 and `n × per ≤ vw − rail − 40 − 836` | Takes the shell's third track (`--dock-w` = the group's width, `body.ai-dock`; `dock.js:303`, `:315`). `position: relative`, no shadow, padding-top 45 (the appbar strip runs over it). 550 × 1000 at 1700; the main column is 926. |
| Stacked | Shift-click a second tab | Panels sit side by side in the flex row, all the same width (`flex: 1 1 <per>px`, `dock.js:282`), ordered by rank through CSS `order` (`dock.js:230-233`). The panel whose tab is higher on the rail sits at the outer edge (Team at the edge, Bookmarks inside, in the shot). At 2240 both seat: `224 916 1100`. At 1480 the pair floats at 1100 wide. |
| Sheet | 901 to 1279 | Under the content in grid row 2, `max-height: calc(100vh − 18rem)`; panels stack vertically, each `flex: 1 1 var(--dock-sheet-h)` = `min(46dvh, 520px)`; the dock pulls up by 43 px (`app.css:5853-5956`). 876 × 503 at 1100. |
| Phone | ≤ 900 | Fixed to the bottom, z 70, height `min(72dvh, 560px)` with the overlay shadow; only the last open panel draws (`app.css:6027-6057`; `dock.js:219`, `:794`). 390 × 560 at 390, tab strip under it. |
| Empty | Nothing to show | §34.1: a panel never renders blank. The Task panel opens a draft when empty (`dockboot.js:183-196`, `dock-draft.js:26-27`). Each resident's own empty line (BM-09, NT-09, NT-10, TM-06, DC-12) is the empty-state primitive (DS-X1), handed to COMPOSITES. |
| Closed | – | The group's width is cleared, `dock-open` is removed and Close all hides (`dock.js:285`, `:308`, `:325`). |

**Styling.** Ground `--rail-bg` for the Task and Bookmarks panels (measured `#f7f7f7` / `#0a0a0d`) with a 1 px `--border` on the left; the floating group adds `--shadow-overlay`. Radius 0.

**Transitions**

| Transition | What moves | Duration, easing | Measured |
|---|---|---|---|
| Open, seated (≥ 1650) | Only `.shell` `grid-template-columns`; the panel's content is present at frame 0 and the track sweeps it in | 420 ms, `--ease`, no delay | `224px 1476px 0px` → `224px 926px 550px` at 1700 |
| Close, seated | The reverse | 420 ms, `--ease` | `224px 926px 550px` → `224px 1476px 0px` |
| Stack, seated (shift-click) | The track widens to the new group width | 420 ms, `--ease` | `224px 1466px 550px` → `224px 916px 1100px` at 2240 |
| Plain click on another tab while one is seated (solo) | Nothing: the same width, the content swaps at once | – | No grid change at 1700 |
| Open or close, floating (1440 to 1649, and below) | Nothing: the panel appears in one frame ("PANELS NOW SIMPLY APPEAR", `app.css:4841`; adopted panels `transition: none`, `:4704`) | – | Only the tab's 120 ms colour change |
| Open, sheet and phone | Nothing | – | as floating |
| Width drag | `body.dock-dragging` kills every transition during the drag (`app.css:4975-4979`) | – | – |
| Reduced motion | `app.css:4857-4859` and the global zero | – | – |

**Shots**

| Variant | Light | Dark |
|---|---|---|
| Floating, 1480 | `shots/sidebar/DS-SIDE-7/floating-default-1480-light.png` | `shots/sidebar/DS-SIDE-7/floating-default-1480-dark.png` |
| Seated, 1700 | `shots/sidebar/DS-SIDE-7/seated-default-1700-light.png` | `shots/sidebar/DS-SIDE-7/seated-default-1700-dark.png` |
| Stacked, seated, 2240 | `shots/sidebar/DS-SIDE-7/stacked-seated-default-2240-light.png` | `shots/sidebar/DS-SIDE-7/stacked-seated-default-2240-dark.png` |
| Stacked, floating, 1480 | `shots/sidebar/DS-SIDE-7/stacked-floating-default-1480-light.png` | `shots/sidebar/DS-SIDE-7/stacked-floating-default-1480-dark.png` |
| Sheet, 1100 | `shots/sidebar/DS-SIDE-7/sheet-default-1100-light.png` | `shots/sidebar/DS-SIDE-7/sheet-default-1100-dark.png` |
| Phone, 390 | `shots/sidebar/DS-SIDE-7/phone-default-390-light.png` | `shots/sidebar/DS-SIDE-7/phone-default-390-dark.png` |
| Bookmarks open (a list body) | `shots/sidebar/DS-SIDE-7/bookmarks-open-default-1480-light.png` | `shots/sidebar/DS-SIDE-7/bookmarks-open-default-1480-dark.png` |
| Task panel empty: opens a draft | `shots/sidebar/DS-SIDE-7/task-empty-draft-default-1480-light.png` | `shots/sidebar/DS-SIDE-7/task-empty-draft-default-1480-dark.png` |

**Motion** (all under `shots/sidebar/DS-SIDE-7/motion/`; each run has a strip and key frames `-f000-0000ms`, `-f003-0120ms`, `-f006-0240ms`, `-f015-0600ms`)

| Transition | Light | Dark | Note |
|---|---|---|---|
| Open, seated, 1700 | `dock-open-seated-1700-light-strip.png` | `dock-open-seated-1700-dark-strip.png` | The glide |
| Open, floating, 1480 | `dock-open-float-1480-light-strip.png` | `dock-open-float-1480-dark-strip.png` | No motion: open at frame 0 |
| Close, seated, 1700 | `dock-close-seated-1700-light-strip.png` | `dock-close-seated-1700-dark-strip.png` | The glide back |
| Stack (shift), seated, 2240 | `dock-stack-2240-light-strip.png` | `dock-stack-2240-dark-strip.png` | The track widens |
| Solo (plain click replaces), 1700 | `dock-solo-1700-light-strip.png` | `dock-solo-1700-dark-strip.png` | Instant swap |
| Open, phone, 390 | `dock-open-phone-390-light-strip.png` | `dock-open-phone-390-dark-strip.png` | No motion |
| Open, sheet, 1100 | `dock-sheet-1100-light-strip.png` | (none: no motion; see the static sheet shots) | No motion |

**Width drag.**
- **Handle:** `.dpanel__grip` (DS-SIDE-10), on the panel's inner (left) edge.
- **Events:** `mousedown` on the grip, then `mousemove` and `mouseup` on `document` (`dock.js:711`, `:759-760`). Mouse only.
- **Range:** `clamp(380, maxPanelW(n), startW + startX − x)` (`dock.js:749`), where `maxPanelW(n) = max(380, floor((vw − rail) / n))` (`dock.js:92-96`). No snap.
- **What persists:** **one width for every panel** (§34.4, the owner's law). The mockup stores it as `aa-dock-w`, written on every move (`dock.js:750`; writing on every move is defect D11), then `layout()`. Dragging wider than the seat line flips the group to floating (`dock.js:275`).
- **In the sheet tier** the same grip drags height, `clamp(220, innerHeight − 140)`, and writes `aa-dock-h` (`dock.js:721-728`). The grip moves to the top edge with `row-resize` (`app.css:5937-5940`). The drag starts from the height of the whole panel box (`panelBox`, `dock.js:723`) but writes a per-panel basis (`--dock-sheet-h`), so with two panels stacked the first move jumps. At ≤ 900 the JS still drags height (`sheeted()` is `max-width: 1279px`, `dock.js:145`) while the CSS leaves the grip on the left edge with `col-resize`, because the top-edge rule sits only inside the 901 to 1279 query (DS-SIDE-D18).

**Keyboard.**
- No shortcuts.
- **Escape** closes the panel opened last (`[...open]` in insertion order), one per press (`dock.js:533-536`). It is global: it does not check the target or `defaultPrevented`, so Escape in a panel's input or menu also closes a panel (DS-SIDE-D7).
- **Focus:** nothing moves focus on open or close (no `.focus()` in `dock.js`). Closing while focus is inside a panel drops it to `<body>`.

**Persistence**

What must persist is the law, not the key: what is open, and what the Task panel shows, survive navigation; one width serves every panel; geometry is replayed before first paint; history lives in memory only (WIRING §34.4 and §34.7, the owner's laws). The keys and stores below are how the mockup does it.

| Key | Store | Written by | Read by |
|---|---|---|---|
| `aa-dock-open` (the open ids) | localStorage | `persist()` `dock.js:764-766` (called at `:369`, `:436`, `:511`, `:796`, `:808`, `:826`, `:995`) | `bootDock` `dock.js:1117`; pre-paint (adds `dock-open`, and `ai-dock` when it would seat) |
| `aa-dock-w` (one width) | localStorage | `dock.js:750` | `dock.js:194`; pre-paint |
| `aa-dock-h` (sheet height) | localStorage | `dock.js:727` | `dock.js:320-323`; **not** replayed before paint |
| `aa-task-open` (what the Task panel shows) | localStorage | `ui.js:6464`, `:6468` | `dockboot.js:547`, `:742`, `:838`, `:854` |
| Dock history (§34.7, §107) | memory only | `dock.js:893-1053` | per page life; capped at 25 |

- **Construction.** `dock.js:80-345` (geometry and layout), `:361-442` (tabs and sheet strip), `:449-605` (frame and panel template), `:705-760` (grip), `:764-829` (persist, open, close, solo), `:893-1106` (history); `dockboot.js:183-196`, `:621`, `:722`; `app.css:4411-5020`, `:5611-5628`, `:5844-6057`.
- **Usages.** SHELL.md SH-25. DOCK.md §1.3, §1.5, §1.6, and every panel section (§2 Clients CL-01 to CL-14, §4 Docs DC-01 to DC-21, §5 Bookmarks BM-01 to BM-09, §6 Projects PJ-01 to PJ-12, §7 Team TM-01 to TM-06, §8 Notifications NT-01 to NT-10, §9 Client intelligence AI-01 to AI-12). TASKS.md S1 to S4 and S9 (the dock Task panel, DP and DT ids), and TT-06 "panel doors". CLIENT.md CL-I12 (the dock strip adds width at 390).
- **Drift.**
  - §34.4 says panels "seat, narrow to 380, then the group floats". The code seats at the requested width or floats, and the floating group can shrink panels below 380 (334 / 389 / 334 at 1280 with three open, DOCK.md D-5). Decided (R39, #303): the 380 floor holds, and a third panel that cannot fit closes the lowest-ranked panel with a one-line stamp. **Ruled (DR-64, raised by the Astra cross-check; owner answer 8, 27 September): float at the width asked for.** R39 settled the floor, not the seating order. The code's rule, "seat at the width asked for, or take over", is dated to the owner on 28 July with the words "I'm liking how you've got that overlay" and the reason that seating on the minimum made a drag unable to reach its width (`dock.js:258-273`, commit `3abbe90`). §34.4's "narrow to 380" was written two days later (commit `0fa736c`). **Note amending WIRING §34.4** (the mockup repository is read-only, so the amendment lives here): where §34.4 says panels "seat, narrow to 380, then the group floats", read "seat at the width asked for, or float at that width"; the 380 floor and the third-panel close (R39) stand. Build all three.
  - Floating panels appear with no motion while seated panels glide (`app.css:4841`). Kept as drawn (DR-58; a note says "PANELS NOW SIMPLY APPEAR").
- **Defects not to copy.** DS-SIDE-D7, D9, D11, D13, D14, D15, D17, D18, D19.

## DS-SIDE-8 Panel head

- **Purpose.** Name the place, carry the view's own controls, and close it (§34.3).
- **Anatomy (`dock.js:563-605`, `:1068-1106`).** `.dpanel__head` > `.dpanel__id` (icon `i.fi` at .9rem `--text-muted` + label) · the view's controls (for example `a.dpanel__out` link-out, `.dpanel__new` +, `.dpanel__goto`, `.dpanel__full`) · `span.dpanel__div` (1 px × 1.1em `--border`) · back · forward · X (DS-SIDE-9).
- **Styling.** 549 × 59, padding 16 16 16 24, 1 px bottom `--border`. The label is Funnel Display 16.8 / 500 `--text`, with an ellipsis (`app.css:4466-4473`, `:5089-5095`).
- **Variants kept.** One head. What varies is only which view controls sit left of the divider.
- **States.** The label never shows the open item's name (§34.3). Back and forward are disabled, never hidden, when there is nothing behind or ahead (DK-11, DK-12).

| Variant | Light | Dark |
|---|---|---|
| Projects (link-out, divider, back, forward, X) | `shots/sidebar/DS-SIDE-8/projects-default-1480-light.png` | `shots/sidebar/DS-SIDE-8/projects-default-1480-dark.png` |
| Team (no link-out, so no divider) | `shots/sidebar/DS-SIDE-8/team-default-1480-light.png` | `shots/sidebar/DS-SIDE-8/team-default-1480-dark.png` |
| Clients (two dividers: DS-SIDE-D14) | `shots/sidebar/DS-SIDE-8/clients-default-1480-light.png` | `shots/sidebar/DS-SIDE-8/clients-default-1480-dark.png` |

- **Construction.** `dock.js:563-605`, `:610`, `:1068-1106`; `dockboot.js:312-313`, `:378`, `:408`, `:471`; `app.css:4466-4479`, `:5089-5095`, `:5575`, `:5588`, `:12390-12391`.
- **Usages.** DOCK.md DK-08, DK-09, DK-10, CL-01 to CL-04, PJ-01. TASKS.md DP-01 to DP-06. DOCK.md AI-01 to AI-05 (drift below).
- **Drift.**
  - **Client intelligence builds its own head:** `.aip__head` / `.aip__acts` / `.aip__actdiv` / `.aip__x` (`dock-ai.js:145`, `:303-315`; `app.css:695`, `:1736`, `:2451`, `:2897`). Its close is 1.6rem `--text-muted` with an `--accent` hover and a rotating glyph (AI-05). Dropped in favour of the one head (DR-3).
  - **The divider is inconsistent:** panels without a link-out (Docs, Bookmarks, Team, Notifications) have no divider, which is contrary to §107's "one divider, then back, forward, X". Clients has two. Keep exactly one divider before the dock's own group.

## DS-SIDE-9 Panel head button (close, back, forward)

- **Purpose.** The dock's own control group, right of the divider: back and forward walk the dock's history (§34.7), and X closes this panel only (§34.3).
- **Anatomy.** `button.dpanel__x` (`[data-dock-close]`, `fi-rr-cross-small`, `aria-label="Close <Label>"`); `button.dpanel__x.dpanel__nav` (`[data-dock-back]` / `[data-dock-fwd]`, `fi-rr-angle-small-left` / `-right`, `aria-label` and `title` "Back — where the dock was" / "Forward — where the dock was").
- **Styling.** 26 × 26, padding 1 6, glyph 14.4 px, `--text-muted` (`app.css:4474-4478`).
- **States.** Hover: `--text` (no fill, no transition). Focus-visible: the global ring. Disabled (back or forward with nothing to walk to): opacity .4, `not-allowed` cursor (`app.css:12390-12391`).

| Variant / state | Light | Dark |
|---|---|---|
| Close: default, hover, focus-visible | `shots/sidebar/DS-SIDE-9/close-{default,hover,focus-visible}-1480-light.png` | `shots/sidebar/DS-SIDE-9/close-{default,hover,focus-visible}-1480-dark.png` |
| Back: default, hover, focus-visible, disabled | `shots/sidebar/DS-SIDE-9/back-{default,hover,focus-visible,disabled}-1480-light.png` | `shots/sidebar/DS-SIDE-9/back-{default,hover,focus-visible,disabled}-1480-dark.png` |

- **Construction.** `dock.js:1049-1053` (`paintNav`), `:1068-1106` (`addNav`); `app.css:4474-4478`, `:12390-12391`.
- **Usages.** DOCK.md DK-11, DK-12, DK-13, CL-04, AI-04. TASKS.md DP-06.
- **Drift.** The AI head's close (AI-05) and Close all (DS-SIDE-5) are other dialects of "close": ruled by DR-3 (one close, `--text` hover, no rotate; Close all stays red). The walking panels' inner backs (CL-13 "Back to the client list", DC-20 "All documents") are the panel's own walk (§34.3), not the dock's history; they stay separate controls, and belong to COMPOSITES.

## DS-SIDE-10 Panel width grip

- **Purpose.** Drag every panel's shared width (or the sheet's height).
- **Anatomy.** `div.dpanel__grip[aria-hidden]`, 6 px at `left: -3px`, `col-resize`, z 5 (`dock.js:705-710`; `app.css:4481-4482`). In the sheet tier it moves to the top edge with `row-resize` (`app.css:5937-5940`).
- **States.** Idle: invisible. Hover and dragging: `--accent-ring` (accent at 35 percent).

| State | Light | Dark |
|---|---|---|
| Idle, hover | `shots/sidebar/DS-SIDE-10/grip-{default,hover}-1480-light.png` | `shots/sidebar/DS-SIDE-10/grip-{default,hover}-1480-dark.png` |

- **Usages.** DOCK.md DK-14.
- **Drift.** The same component as the rail grip (DS-SIDE-16), except that this one suspends transitions during a drag and the rail's does not. Keep this behaviour for both.
- **Defects not to copy.** DS-SIDE-D11, D12, D18 (at ≤ 900 it keeps the `col-resize` left edge while the JS drags height, `app.css:4481`, `dock.js:721`; now a numbered defect).

### WIRING §34 restated as tests

| # | Law (source) | Test |
|---|---|---|
| T-D1 | Plain click replaces (§34.2). | With Team open, a plain click on Bookmarks leaves only Bookmarks open. |
| T-D2 | Plain click on the only open panel closes it (§34.2, `dock.js:366`). | With Team alone open, a plain click on Team leaves nothing open. |
| T-D3 | Shift stacks (§34.2). | With Team open, a shift-click on Bookmarks leaves both open; a shift-click on Team again closes only Team. |
| T-D4 | Every programmatic open obeys the same law through `openByGesture` (§34.2; `dock-shared.js:32-40`). | A plain click on a task row with Team open leaves only Task open; a shift-click leaves both. (Fails for `[data-ask]`: DS-SIDE-D13.) |
| T-D5 | Solo fires only when the gesture brings the panel out (§34.2). | With Team and Task stacked, a plain click on a second task row while Task is already open keeps Team open and changes the view in Task. |
| T-D6 | A restore never solos (§34.2). | Store `["team","marks"]` in `aa-dock-open`, reload: both are open. |
| T-D7 | One panel never draws another's subject (§34.2). | No task view renders inside the Projects panel. |
| T-D8 | The edge is a place: tabs never appear or vanish with state (§34.1). | The rail has the same eight tabs in the same order on every agency page, whether or not anything is open. |
| T-D9 | Rank is the panel's, not the order of opening (§34.1). | Open Bookmarks then shift-open Team, and open Team then shift-open Bookmarks: the layout is the same both times. |
| T-D10 | No panel renders blank (§34.1). | Open Task with nothing stored: a draft shows. Every other resident shows an honest empty line. |
| T-D11 | Ids never rename (§34.1). | `aa-dock-open` and `ORDER` use `ai`, `notifs`, `team`, `clients`, `todos`, `task`, `marks`, `notes`. |
| T-D12 | The head names the panel, never the item (§34.3). | Rename the open task: the head still reads "Task". |
| T-D13 | X closes what is named beside it, and the close reaches the tenant (§34.3). | Close Task while its timer runs: the panel closes, the timer stops, and the stored row is dropped. Other panels stay open. |
| T-D14 | A walking panel's own back is separate from the open-panel stack (§34.3). | In Clients, open a client, then press the panel's inner back: the list returns and no panel closes. |
| T-D15 | What is open survives navigation; a draft does not (§34.4). | Open Team and Task, navigate: both are open on the next page before first paint. A half-typed draft is gone. |
| T-D16 | Geometry is replayed before paint (§34.4). | With a panel stored at 1700, the first paint already has the seated track, and no transition runs on load. |
| T-D17 | One stored width for all panels (§34.4). | Drag Team to 600, open Bookmarks: it is 600. |
| T-D18 | The 836 content floor never moves (§34.4). | At any width, main column ≥ 836 while a panel is seated; if it would not be, the group floats. |
| T-D19 | Panels seat at the width asked for, or float at that width; they never narrow towards 380 first; the 380 floor holds (owner answer 8, 27 September, amending §34.4 by the note under DS-SIDE-7 drift; R39, #303). | At the seat line minus 1 px a panel floats at the width asked for; no seated or floating panel is ever under 380. When a third panel cannot fit, the lowest-ranked open panel closes and a one-line stamp says so. (The mockup fails this when floating: DOCK D-5.) |
| T-D20 | ≤ 1279 is the sheet; ≤ 900 draws one panel, under a strip that is always visible (§34.4; R33, #303). | At 1100 two open panels stack vertically under the content; at 390 the tab strip is on screen with nothing open, and only the last opened panel draws. (The mockup fails the strip: DS-SIDE-D9.) |
| T-D21 | Seams live at module scope (§34.5). | `window.aaTasks`, `aaProjects`, `aaTask`, `aaAsk` and `__aaProjectMount` exist before any panel is opened. |
| T-D22 | Counts derive and are uncapped (§34.5). | Seed 120 unread notifications: the chip reads "120". |
| T-D22a | Opening a panel never clears a count (R36, #303). | Open Notifications with 12 unread: the chip still reads 12 until items are answered. |
| T-D22b | Only panels with a body get a door (R34, #303). | Every tab on the rail opens a panel that renders content or an honest empty line; no tab exists for a panel without a body. |
| T-D22c | Hover-only controls show at rest below 900 (R37, #303). | At 390, every control that appears only on hover at 1480 (for example row actions inside a panel) is visible without hover. The tab callout (DS-SIDE-3) is a label, not a control, and is exempt. |
| T-D22d | A second click on an open record means nothing new (R38, #303). | Click a task row, then click it again: the panel set and the view are unchanged, and no history entry is added. |
| T-D23 | A new panel follows the checklist (§34.6). | Registered in dockboot, placed in `ORDER`, a glyph distinct at 18 px, honest empty states, both faces considered. |
| T-D24 | Back and forward undo the last dock change, as a whole state (§34.7). | Open Team, scroll it, plain-click Bookmarks, press back: Team is open again at the same scroll position. |
| T-D24a | An entry holds every open panel's view, not only the walking ones (§34.7: "what each walking or record-bearing panel is standing on · the active tab inside it", `WIRING.md:2266-2270`). | In Notifications switch to "No response needed", in AI pick another conversation, in Team select another person, in Projects add a filter; open Bookmarks, press back: each returns as left. (The mockup fails this: DS-SIDE-D19.) |
| T-D25 | Scroll and the active tab are sealed, never pushed (§34.7). | Switching tabs inside a panel five times adds no history entries. |
| T-D26 | History is capped at 25 and lives in memory (§34.7). | Twenty-six changes: the oldest cannot be reached. Reload: back is disabled. |
| T-D27 | One back per scope (§34.7). | The appbar back walks pages; the dock head's back walks the dock only. |

---

# Part 2: the left navigation rail

## DS-SIDE-11 Navigation rail

- **Purpose.** The Hub's one-level map: which section you are in. The tab row under the appbar says which page of that section.
- **Anatomy.** `nav.rail[aria-label="Hub"]` holds the brand (DS-SIDE-12), one or more `.rail__group`s of rail items (DS-SIDE-13), the railmark (DS-SIDE-14), the fold button (DS-SIDE-15) and the width grip (DS-SIDE-16). The groups are rebuilt from `routes.json` by `canonical-routes.js:151-235`.
- **Variants kept.** Expanded (default), collapsed, dragged to a custom width, drawer (≤ 900), client workspace (DS-SIDE-19).

**States**

| State | How it is reached | What it looks like |
|---|---|---|
| Expanded | Default | 224 wide, 100vh, sticky at top 0, `overflow-y: auto`, padding 24 0, column gap 24 (`app.css:143-147`, `:2830`). |
| Collapsed | Fold button, or `aa-rail-collapsed=1` replayed before paint | 56 wide. Padding-top becomes `--s-5` + 30 = 54, so the fold button sits above the brand (`app.css:1643-1667`). Labels, the HUB label and group labels are `display: none`. Items should show a 16 px icon, but on canonical addresses they show nothing (DS-SIDE-D1). |
| Dragged | Width grip | Any width from 170 to 400; the 320 shot shows labels with more air. |
| Drawer closed (≤ 900) | Default at ≤ 900 | `position: fixed`, `transform: translateX(-100%)`, `visibility: hidden`, z 60 (`app.css:640-650`). |
| Drawer open (≤ 900) | Hamburger (DS-SIDE-17) | `translateX(0)`, visible, `--shadow-overlay`, over a 40 percent black backdrop (DS-SIDE-18) (`app.css:651-654`). There is no close button inside the drawer. |
| Theme or face shift | Theme or face switch | Background and colour transition over 420 ms while `body.aa-shifting` is set; a 500 ms timer removes the class (`app.css:2310-2314`, `portal.js:142-146`). |

**Styling**

| Property | Light / dark |
|---|---|
| Ground | `--rail-bg` `#f7f7f7` / `#0a0a0d` (dark `--rail-bg: var(--bg)`, `tokens.css:65`, `:81`). The drawer measures `--rail-bg` too; the `--bg` at `app.css:640-650` is overridden by `app.css:4206`. |
| Right border | 1 px `--border` (`#000` at 12 percent / `#f5f5f5` at 10 percent) |
| Width | 224 expanded, 56 collapsed, 170 to 400 dragged, `min(300px, 84vw)` as a drawer. The DS declares `--sidebar-w 220px` and `--sidebar-collapsed-w 58px` (`hub-ds/radius.css:54-58`) and nothing uses them; 224 / 56 as built wins and the tokens are updated (DR-8, TICKET-PLAN R54). |
| Padding, gap | 24 0 (`--s-5`) and gap 24; collapsed 54 0 24 |
| Shadow | None docked; `--shadow-overlay` `0 24px 60px oklch(0 0 0 / .45)` as an open drawer |
| Radius | 0 |

**Transitions** (all read from the CSS and JS, then measured with `motion.mjs`)

| Transition | Properties | Duration, easing, delay | Reduced motion | Source |
|---|---|---|---|---|
| Collapse | `.shell` `grid-template-columns` `224px 1256px 0px` → `56px 1424px 0px` at 1480. Labels, logo and icons swap instantly (`display`). The railmark shrinks and moves (DS-SIDE-14). | 420 ms, `--ease`, no delay | None (`app.css:4857-4858`) | `app.css:4856`; `portal.js:625-645` |
| Expand | The reverse: `56px` → `224px`. | 420 ms, `--ease` | None | as above |
| Width drag | Each `mousemove` sets `--rail-w`, which runs through the same 420 ms transition, so the rail trails the cursor. Measured: one jump 224 → 340 took 420 ms to land. | 420 ms per move | None | `portal.js:666-682`; DS-SIDE-D4 |
| Drawer open | Rail `transform` `translateX(-300px)` → `0`. Backdrop `opacity` 0 → 1. Rail groups fade in (`aa-fade`). The overlay shadow snaps on. | Transform and backdrop 220 ms `--ease`, no delay. Groups 420 ms with an 80 ms delay, `backwards` fill. | Durations zeroed globally; the 80 ms delay is not (DS-SIDE-D6) | `app.css:2240-2245`, `:653`, `:662-664` |
| Drawer close | Transform `0` → `translateX(-300px)` and the shadow fade are scheduled over 220 ms, but `visibility` goes hidden at once, so **the slide-out is never seen**; only the backdrop fades. | 220 ms `--ease` (not visible) | as above | `app.css:646` shadowed by `:2242`; DS-SIDE-D5 |

**Shots**

| Variant / state | Light | Dark |
|---|---|---|
| Expanded, 1480 | `shots/sidebar/DS-SIDE-11/expanded-default-1480-light.png` | `shots/sidebar/DS-SIDE-11/expanded-default-1480-dark.png` |
| Collapsed, canonical address (blank, DS-SIDE-D1) | `shots/sidebar/DS-SIDE-11/collapsed-default-1480-light.png` | `shots/sidebar/DS-SIDE-11/collapsed-default-1480-dark.png` |
| Collapsed, legacy address `/agency/portfolio/` (3 of 7 icons) | `shots/sidebar/DS-SIDE-11/collapsed-legacy-route-default-1480-light.png` | `shots/sidebar/DS-SIDE-11/collapsed-legacy-route-default-1480-dark.png` |
| Dragged to 320 | `shots/sidebar/DS-SIDE-11/dragged-320-default-1480-light.png` | `shots/sidebar/DS-SIDE-11/dragged-320-default-1480-dark.png` |
| Drawer open, 900 | `shots/sidebar/DS-SIDE-11/drawer-open-default-900-light.png` | `shots/sidebar/DS-SIDE-11/drawer-open-default-900-dark.png` |
| Drawer open, 390 | `shots/sidebar/DS-SIDE-11/drawer-open-default-390-light.png` | `shots/sidebar/DS-SIDE-11/drawer-open-default-390-dark.png` |

**Motion**

| Transition | Light strip | Dark strip | Key frames |
|---|---|---|---|
| Collapse, 1480 | `shots/sidebar/DS-SIDE-11/motion/rail-collapse-light-strip.png` | `shots/sidebar/DS-SIDE-11/motion/rail-collapse-dark-strip.png` | `rail-collapse-<theme>-f000-0000ms.png` … `-f015-0600ms.png` |
| Expand, 1480 | `shots/sidebar/DS-SIDE-11/motion/rail-expand-light-strip.png` | `shots/sidebar/DS-SIDE-11/motion/rail-expand-dark-strip.png` | `rail-expand-<theme>-f0*.png`; `f015` shows the railmark landing 18 px high (DS-SIDE-D3) |
| Width drag 224 → 340 | `shots/sidebar/DS-SIDE-11/motion/rail-drag-light-strip.png` | `shots/sidebar/DS-SIDE-11/motion/rail-drag-dark-strip.png` | `rail-drag-<theme>-f0*.png` |
| Drawer open, 390 | `shots/sidebar/DS-SIDE-11/motion/drawer-open-390-light-strip.png` | `shots/sidebar/DS-SIDE-11/motion/drawer-open-390-dark-strip.png` | `drawer-open-390-<theme>-f0*.png` |
| Drawer open, 900 | `shots/sidebar/DS-SIDE-11/motion/drawer-open-900-light-strip.png` | `shots/sidebar/DS-SIDE-11/motion/drawer-open-900-dark-strip.png` | `drawer-open-900-<theme>-f0*.png` |
| Drawer close, 390 | `shots/sidebar/DS-SIDE-11/motion/drawer-close-390-light-strip.png` | `shots/sidebar/DS-SIDE-11/motion/drawer-close-390-dark-strip.png` | `drawer-close-390-<theme>-f0*.png`: the rail is gone at 0 ms |

The collapse is 1480 only. At 390 and 900 the rail cannot collapse. It is a drawer, captured at both widths.

**Width drag**
- **Handle:** `div.railgrip` (DS-SIDE-16), `aria-hidden`, created by `portal.js:662-665`.
- **Events:** `mousedown` on the grip, then `mousemove` and `mouseup` on `document` (`portal.js:666-681`). No pointer, touch or keyboard events, and no double-click handler.
- **Range:** `clamp(170, clientX, 400)` (`portal.js:670`). There is no snap and no collapse threshold: dragging to 170 stays at 170, and collapsing is only the fold button.
- **During the drag:** `.active` on the grip keeps it tinted (`portal.js:668`, `:675`). There is no body class and no forced cursor, so the cursor can revert off the 6 px strip.
- **What persists:** the width, replayed before paint (the pre-paint law, WIRING §34.4). The mockup stores it as `aa-rail-w`, written on **every** move (`portal.js:671-672`; defect D11).

**Keyboard**
- There is no shortcut to collapse or expand the rail.
- **Tab order:** brand (not focusable), items in order, then the fold button, because it is appended last (`portal.js:627`) although it sits at the top. The grip is not focusable.
- **Escape** closes the drawer (`portal.js:530`). It is global and fires on every Escape at every width, together with the dock's Escape (DS-SIDE-D7).
- **The drawer is not modal:** no focus trap, no focus moved in on open, and no focus returned to the hamburger on close (`portal.js:510-531`).

**Persistence**

What must persist: the rail's collapsed state and its width survive navigation and are replayed before first paint (the pre-paint law, WIRING §34.4, which covers every stored layout preference). The keys and stores below are how the mockup does it.

| Key | Store | Written by | Read by |
|---|---|---|---|
| `aa-rail-collapsed` (`'1'` or `''`) | localStorage | `portal.js:642` | `portal.js:645`; pre-paint `route-home/index.html:18` (and every shell page, for example `agency/portfolio/index.html:18`) |
| `aa-rail-w` (px) | localStorage | `portal.js:672`, every mousemove | `portal.js:635`, `:652`; pre-paint. The pre-paint also feeds it into the dock's seat maths. |
| `aa-rail-open` | retired | – | `portal.js:317` notes it is retired |

The drawer's open state is not stored: every page load starts with it shut.

- **Construction.** `portal.js:510-531` (drawer), `:599-623` (icons), `:625-645` (fold), `:648-682` (grip), `:346-405` (railmark); `canonical-routes.js:151-235` (rebuild); `app.css:141-182`, `:634-673`, `:1467-1472`, `:1614-1667`, `:2240-2245`, `:2287-2295`, `:4856-4858`.
- **Usages.** SHELL.md: SH-1, SH-9 (every shell page). PORTAL.md: the client face wears the same rail with the portal's groups (SHELL §4). Every page inventory (AGENCY, BOARDS, CLIENT, PORTAL, TASKS, WORKBENCH) renders inside it.
- **Drift.** The DS declares 220 / 58 and the mockup measures 224 / 56 (`hub-ds/radius.css:54-58` against the pre-paint hooks; SHELL I10). Ruled: 224 / 56 as built, tokens updated (DR-8, TICKET-PLAN R54).
- **Defects not to copy.** DS-SIDE-D1, D3, D4, D5, D6, D7, D8, D10, D11.

## DS-SIDE-12 Rail brand

- **Purpose.** Identity at the top of the rail. It is not a link.
- **Anatomy.** `.rail__brand` > `.rail__logo` (a mask of `logo-long.svg`) + `.rail__hub` "HUB" label (`app.css:148-167`).
- **Variants kept.** Expanded (wordmark plus HUB), collapsed (planet mark only).
- **States.** No interactive states.
- **Styling.**
  - Brand box: 223 × 39, padding 0 24, column gap .4rem.
  - Wordmark: `min(176px, 100%)` wide, aspect 566.93 / 57.9, fill `--text` `#000` / `#f8f8f8`.
  - HUB label: Display 13 / 14.3, 500, +.26 tracking, uppercase, `--text-muted` `#8c857f` / 55 percent (DR-10 fold; the mockup drew 46).
  - Collapsed: the planet mask `logo-planet.svg` at 24 wide, aspect 566.93 / 463.61, centred, padding 0 (`app.css:1651-1657`).
- **Motion.** The swap is a `display` toggle and snaps at the start of the 420 ms collapse.

| Variant | Light | Dark |
|---|---|---|
| Expanded | `shots/sidebar/DS-SIDE-12/expanded-default-1480-light.png` | `shots/sidebar/DS-SIDE-12/expanded-default-1480-dark.png` |
| Collapsed | `shots/sidebar/DS-SIDE-12/collapsed-default-1480-light.png` | `shots/sidebar/DS-SIDE-12/collapsed-default-1480-dark.png` |

- **Construction.** `app.css:148-167`, `:1651-1657`.
- **Usages.** SHELL.md SH-2, SH-3.
- **Drift.** The fold button sits at `right: 12px` on the wordmark's line and overlaps the end of "ASTRO" by a few pixels at 224 (visible in the expanded shot). Ruled by DR-61: the build moves the fold button clear of the wordmark.
- **Defects not to copy.** None beyond the overlap.

## DS-SIDE-13 Rail item

- **Purpose.** One Hub section (or one client section inside a client).
- **Anatomy.** `a.rail__item` > optional `i.fi.rail__icon` (injected, `display: none` until collapsed, `app.css:1614`) + `span` label.
- **Variants kept.** Top-level item. The sub-item (`.rail__item--sub`, `app.css:181-182`) is permanently hidden by `.rail__sub { display: none !important }` (`app.css:2825`); it only feeds the tab row. Keep it as data, not as a visual.

**States**

| State | Trigger | Look (light / dark) |
|---|---|---|
| Idle | – | Sans 14 / 21.7, 400, `--text-2` `#6b635d` / `#f8f8f8` at 72 percent; 223 × 36; padding 7.2 24; gap 8; `border-left: 2px solid transparent` (`app.css:170-174`) |
| Hover | `:hover` | Fill `--surface-2` `#f2f2f2` / `#171619`; ink `--text` `#000` / `#f8f8f8` (`app.css:175`). No transition. |
| Pressed | `:active` | Same as hover |
| Focus-visible | keyboard | The global ring DS-F1 (`0 0 0 2px var(--bg), 0 0 0 4px var(--accent)`). It is clipped at the left and right by the rail's `overflow-y: auto`, so only its top and bottom show (DS-SIDE-D8). |
| Current section | `.is-here` (`portal.js:291-295`, `app.css:3146`) or `[aria-current="page"]` (`app.css:176`) | Ink `--text`, weight 500. The railmark (DS-SIDE-14) replaces the left border once `body.railmark-on` is set (`app.css:2295`). |
| Collapsed | `body.rail-collapsed` | Label hidden, icon 16 px (1rem) centred, padding 7.2 0, `title` = label. On canonical addresses there is no icon and no title, so each item is an empty 55 × 14 hit area (DS-SIDE-D1). |
| In the drawer | ≤ 900 | Same as expanded; a click also closes the drawer (`portal.js:529`). |

| Variant / state | Light | Dark |
|---|---|---|
| Idle, hover, focus-visible, pressed | `shots/sidebar/DS-SIDE-13/idle-{default,hover,focus-visible,active}-1480-light.png` | `shots/sidebar/DS-SIDE-13/idle-{default,hover,focus-visible,active}-1480-dark.png` |
| Current section, with hover and focus | `shots/sidebar/DS-SIDE-13/current-{default,hover,focus-visible}-1480-light.png` | `shots/sidebar/DS-SIDE-13/current-{default,hover,focus-visible}-1480-dark.png` |
| Section parent while a child page is current (`/dashboard/portfolio/`) | `shots/sidebar/DS-SIDE-13/section-here-default-1480-light.png` | `shots/sidebar/DS-SIDE-13/section-here-default-1480-dark.png` |
| Current on a legacy address (`aria-current` on the visible item) | `shots/sidebar/DS-SIDE-13/current-legacy-default-1480-light.png` | `shots/sidebar/DS-SIDE-13/current-legacy-default-1480-dark.png` |
| Collapsed, canonical (blank) | `shots/sidebar/DS-SIDE-13/collapsed-blank-{default,hover,focus-visible}-1480-light.png` | `shots/sidebar/DS-SIDE-13/collapsed-blank-{default,hover,focus-visible}-1480-dark.png` |
| Collapsed, legacy (with icon) | `shots/sidebar/DS-SIDE-13/collapsed-icon-{default,hover}-1480-light.png` | `shots/sidebar/DS-SIDE-13/collapsed-icon-{default,hover}-1480-dark.png` |

- **Construction.** `canonical-routes.js:150-165` (`nodePath`, `railItem`); `portal.js:599-623` (icon injection); `app.css:170-182`, `:1645-1667`, `:2295`, `:3146`.
- **Usages.** SHELL.md SH-4, SH-5, SH-9, SH-31. WORKBENCH.md: the workbench page's own rail markup lists 9 of 14 channels, and `buildTabs()` reads its hidden `.rail__sub` links (WORKBENCH.md line 45). PORTAL.md: the client face's section list.
- **Drift.** "Current" has two markers: `aria-current="page"` (usually on a hidden sub-anchor) and `.is-here` on the visible section item. The rail marks the section; the tab row marks the page (`portal.js:357-363` explains this). Keep both, with one rule (T-R7).
- **Defects not to copy.** DS-SIDE-D1, D8.

## DS-SIDE-14 Railmark

- **Purpose.** The accent bar that says which section you are in, and slides when that changes.
- **Anatomy.** `span.railmark[aria-hidden]`, absolute at left 0 inside the rail.
- **States.** Placed (opacity 1); unplaced (opacity 0 and `railmark-on` removed when the current item cannot be measured: collapsed, drawer shut or no current item, `portal.js:378-381`); placing (`.is-placing`, no transition, used on load and on snaps).
- **Styling.** 2 px wide, height = the item's height (36 expanded, 14 collapsed on canonical addresses), `--accent` `#745cee` in both themes. The item's own 2 px left border goes transparent while the mark is live (`app.css:2295`).
- **Motion.**
  - Slide: `transform` (translateY) and `height` over 220 ms `--ease`; `opacity` 120 ms (`app.css:2287-2293`). Measured: 87 → 195 px over 220 ms.
  - On load it snaps: created with `is-placing`, which is removed after two animation frames plus an 80 ms timer (`portal.js:350-356`, `:394-404`). So the mark never animates in from the top on page load.
  - It follows `aria-current` and `class` changes through a MutationObserver on the rail (`portal.js:1402-1424`).
  - Reduced motion: the global zero only.

| State | Light | Dark |
|---|---|---|
| Placed | `shots/sidebar/DS-SIDE-14/placed-default-1480-light.png` | `shots/sidebar/DS-SIDE-14/placed-default-1480-dark.png` |
| Slide Dashboard → Clients | `shots/sidebar/DS-SIDE-14/motion/railmark-light-strip.png` (+ `railmark-light-f0*.png`) | `shots/sidebar/DS-SIDE-14/motion/railmark-dark-strip.png` (+ `railmark-dark-f0*.png`) |

- **Construction.** `portal.js:346-405`, `:1402-1424`; `app.css:2287-2295`.
- **Usages.** SHELL.md SH-6. Its sibling is the tab underline (SH-19, `span.tabmark`, 420 ms, carried across page loads through sessionStorage `aa-tabmark-from`). That belongs to the tab row, which is handed to COMPOSITES.
- **Drift.** The railmark moves over 220 ms and the tab underline over 420 ms: two speeds for one idea. Both kept (DR-62): the underline travels further.
- **Defects not to copy.** DS-SIDE-D3 (the mark lands 18 px high after an expand).

## DS-SIDE-15 Rail fold button

- **Purpose.** Collapse or expand the rail.
- **Anatomy.** `button.railfold` > `i.fi` `fi-rr-angle-double-left` (expanded) or `fi-rr-angle-double-right` (collapsed). The icon class swaps instantly (`portal.js:630`).
- **States.**
  - Idle: `--text-muted`, no fill.
  - Hover: `--text` on `--surface` (`#fff` / `#0f0f12`), colour and background over 120 ms (`app.css:1633-1637`).
  - Focus-visible: the same fill plus the global ring; the rule sets `outline: none` (`app.css:1637`).
  - Hidden at ≤ 900 (`display: none` until `app.css:1644`).
- **Styling.** 22 × 22, glyph 8.32 px (.52rem). Expanded: absolute at `top: calc(var(--s-5) + 1.15rem)`, `right: var(--s-3)` (x 189, y 42). Collapsed: `top: var(--s-5)`, `right: 16px` (x 17, y 24) (`app.css:1623-1635`, `:1666`).
- **ARIA.** `aria-label` switches between "Collapse the menu" and "Expand the menu" (`portal.js:631`). There is no `aria-expanded`.

| State | Light | Dark |
|---|---|---|
| Expanded: default, hover, focus-visible | `shots/sidebar/DS-SIDE-15/expanded-{default,hover,focus-visible}-1480-light.png` | `shots/sidebar/DS-SIDE-15/expanded-{default,hover,focus-visible}-1480-dark.png` |
| Collapsed: default, hover, focus-visible | `shots/sidebar/DS-SIDE-15/collapsed-{default,hover,focus-visible}-1480-light.png` | `shots/sidebar/DS-SIDE-15/collapsed-{default,hover,focus-visible}-1480-dark.png` |

- **Construction.** `portal.js:625-645`; `app.css:1623-1637`, `:1666`.
- **Usages.** SHELL.md SH-7.
- **Drift.** Its hover dialect (text on surface) matches the dock tab (DS-SIDE-2). Keep one "edge button" hover.
- **Defects not to copy.** DS-SIDE-D10 (last in tab order, no `aria-expanded`).

## DS-SIDE-16 Rail width grip

Alias of **DS-SIDE-10** Panel width grip: one edge grip with an axis, as this entry's own drift line proposed. The rail's specifics (at `right: -3px`, hidden when collapsed and at ≤ 900, `portal.js:648-682`, `app.css:1467-1472`, `:1660`, SH-8, defects DS-SIDE-D4, D11, D12) and its shots are carried in `CATALOGUE.md`, "Carried from retired entries".

## DS-SIDE-17 Navigation toggle (hamburger)

- **Purpose.** Open the rail drawer at ≤ 900.
- **Anatomy.** `button.navtoggle` > `span.navtoggle__bars` (three bars 14 × 1.5). `order: -1` puts it first in the page header.
- **States.** Idle; focus-visible (global ring). `aria-expanded` toggles, and nothing else about its look changes. There is no hover rule. It is hidden above 900.
- **Styling.** 32 × 32, 1 px `--border-strong` (`#000` at 32 percent / `#fafafa` at 20 percent), transparent fill, ink `--text` (`app.css:217-228`, shown at `:655`).
- **Motion.** None of its own. It starts the drawer transition (DS-SIDE-11).

| Width / state | Light | Dark |
|---|---|---|
| 900: default, hover, focus-visible, expanded | `shots/sidebar/DS-SIDE-17/toggle-{default,hover,focus-visible,expanded}-900-light.png` | `shots/sidebar/DS-SIDE-17/toggle-{default,hover,focus-visible,expanded}-900-dark.png` |
| 390: the same | `shots/sidebar/DS-SIDE-17/toggle-{default,hover,focus-visible,expanded}-390-light.png` | `shots/sidebar/DS-SIDE-17/toggle-{default,hover,focus-visible,expanded}-390-dark.png` |

- **Construction.** `portal.js:510-531`; `app.css:217-228`, `:655`.
- **Usages.** SHELL.md SH-23.
- **Defects not to copy.** Its `aria-label` stays "Open navigation" when the drawer is open (`portal.js:516`). It has no hover state; and once open it sits under the backdrop, so it cannot close what it opened.

## DS-SIDE-18 Drawer backdrop

- **Purpose.** Dim the page behind the open drawer; a click on it closes the drawer.
- **Anatomy.** `div.navbackdrop`, fixed, inset 0, z 55.
- **Styling.** A literal `oklch(0 0 0 / .4)` in both themes, not a token (`app.css:656-664`).
- **Motion.** Opacity 0 → 1 over 220 ms `--ease` on open, and 1 → 0 on close. It is the only part of the close that is visible (`app.css:2240`, which beats `:662`).
- **Shots.** The last key frame of the drawer-open run: `shots/sidebar/DS-SIDE-11/motion/drawer-open-390-light-f015-0600ms.png` and `…-dark-f015-0600ms.png`; the fade is in the same run's strips.
- **Usages.** SHELL.md SH-24.
- **Drift.** A literal colour where every other scrim uses the overlay shadow tokens. Tokenise it (handed to TOKENS).

## DS-SIDE-19 Client workspace group

- **Purpose.** Inside one client, the rail holds that client's sections, plus a way back to the client list.
- **Anatomy.** `.rail__label` row > `button.btn.btn--primary.btn--sm[data-back-to-clients]` (DS-K1 / DS-K2, `fi-rr-angle-small-left` + "Back to Clients"), then client sections in the rail-item dress (DS-SIDE-13): Overview, Projects, Channel workbench, Library, Docs, Forms, Account.
- **States.**
  - Expanded: the label row is 223 × 35, padding 0 24 8. The button is 123 × 27, Sans 12 500; black on white / `#f8f8f8` on void; hover `--accent` fill; focus-visible outline plus ring.
  - Collapsed: the whole label row is hidden (`app.css:1646`), so there is **no way back** from the collapsed rail (DS-SIDE-D2).

| Variant / state | Light | Dark |
|---|---|---|
| Group expanded | `shots/sidebar/DS-SIDE-19/expanded-default-1480-light.png` | `shots/sidebar/DS-SIDE-19/expanded-default-1480-dark.png` |
| Group collapsed (no back, no icons) | `shots/sidebar/DS-SIDE-19/collapsed-default-1480-light.png` | `shots/sidebar/DS-SIDE-19/collapsed-default-1480-dark.png` |
| Back row | `shots/sidebar/DS-SIDE-19/back-row-default-1480-light.png` | `shots/sidebar/DS-SIDE-19/back-row-default-1480-dark.png` |
| Back button: default, hover, focus-visible | `shots/sidebar/DS-SIDE-19/back-button-{default,hover,focus-visible}-1480-light.png` | `shots/sidebar/DS-SIDE-19/back-button-{default,hover,focus-visible}-1480-dark.png` |

- **Construction.** `canonical-routes.js:163-169`, `:198-212` (`renderGroup(manifest.clientWorkspace, true)`, the click goes to `/clients/`); `app.css:169`.
- **Usages.** SHELL.md SH-30, SH-31, SH-32 (the tab rows it drives). SH-33 (the client identity) is in the appbar, not the rail: handed to COMPOSITES. CLIENT.md and WORKBENCH.md pages all render inside this group.
- **Drift.** "Back to Clients" is the only rail control drawn as a filled primary button. Every other rail control is quiet. It is also a `<button>` running `location.href`, so it cannot be middle-clicked (SHELL I7). Keep it as a variant (a group header action) in the filled primary dress, shown as a back icon when the rail is collapsed (DR-60). It is a real link (anchor semantics, `PLACEHOLDERS.md` row `SH-30`).
- **Defects not to copy.** DS-SIDE-D2, and I7.

### Rules for Part 2, restated as tests

| # | Rule | Test |
|---|---|---|
| T-R1 | The rail is one level. | No visible `.rail__item--sub` at any width. |
| T-R2 | Collapse and expand move the shell, not an overlay. | After the fold click, `.shell` `grid-template-columns` goes 224 → 56 over 420 ms `--ease`, and content x moves by 168. |
| T-R3 | No motion on load. | With `aa-rail-collapsed=1` stored, the first paint already shows a 56 px rail, and no transition runs before `dock-ready`. |
| T-R4 | A collapsed item is never blank. | Every visible `.rail__item` in the collapsed rail has a visible icon and an accessible name, on every canonical address. (Fails today: DS-SIDE-D1.) |
| T-R5 | The width stays between 170 and 400 and survives navigation. | Drag to 100 → 170; drag to 600 → 400; reload → same width before paint. |
| T-R6 | Collapsed wins over a stored width. | With both keys stored, the rail is 56. Expanding restores the stored width, not 224. |
| T-R7 | The rail marks the section; the tab row marks the page. | On `/dashboard/portfolio/`, the Dashboard item is `.is-here` with the railmark on it, and the tab row has Portfolio current. |
| T-R8 | The railmark slides between sections and never animates on load. | Change the current section in page: the mark moves over 220 ms. Load a page: the mark is placed at frame 0. |
| T-R9 | At ≤ 900 the rail is a drawer. | The hamburger opens it; the backdrop, Escape and an item click close it. |
| T-R10 | Inside a client, the rail is the client's sections plus a way back. | On `/clients/:client/*`, seven client items and a Back to Clients control, in both expanded and collapsed. (Collapsed fails today: DS-SIDE-D2.) |

---

## Defects found (record, do not copy)

| # | Defect | Evidence |
|---|---|---|
| DS-SIDE-D1 | **The collapsed rail is blank on canonical addresses.** Confirmed. `RAIL_ICONS` is keyed by legacy paths only (`portal.js:599-607`), matched by exact href (`portal.js:612-614`), and the canonical rebuild writes `/dashboard/`-style hrefs (`canonical-routes.js:150-165`). A second, independent cause: `canonical-routes.js` rebuilds the groups at DOMContentLoaded (`:198-203`) after `portal.js` (deferred, `init` at `:1489-1490`) has already injected icons (`:1360`), so the rebuild wipes them. Each item is an empty 55 × 14 hit area with no `title`. On a legacy address only 3 of 7 items get an icon. | `shots/sidebar/DS-SIDE-11/collapsed-default-1480-*.png`; `DS-SIDE-13/collapsed-blank-*`; `DS-SIDE-11/collapsed-legacy-route-*` |
| DS-SIDE-D2 | The collapsed rail hides Back to Clients, so there is no way back from a client workspace. | `app.css:1646`; `shots/sidebar/DS-SIDE-19/collapsed-default-1480-*.png` |
| DS-SIDE-D3 | **New:** after an expand, the railmark lands 18 px high: at y 69 while the current item is at y 87. It is re-placed while the rail's padding is still changing and is not re-measured after the 420 ms sweep. | `shots/sidebar/DS-SIDE-11/motion/rail-expand-light-f015-0600ms.png`; motion data `translateY 98 → 69` |
| DS-SIDE-D4 | The width drag lags the cursor: each move's `--rail-w` runs through the 420 ms grid transition. There is no `rail-dragging` equivalent of `body.dock-dragging`. | `portal.js:671`; `app.css:4856`, `:4975-4979`; `DS-SIDE-11/motion/rail-drag-*-strip.png` |
| DS-SIDE-D5 | The drawer's slide-out is never seen: `app.css:2242` replaces `:646` and drops the delayed `visibility`, so the rail hides at once on close. The open rule leaves `box-shadow` out, so the shadow snaps on. | `DS-SIDE-11/motion/drawer-close-390-*-strip.png` (the rail is gone at 0 ms) |
| DS-SIDE-D6 | Reduced motion zeroes durations but not the drawer groups' 80 ms `animation-delay` with a `backwards` fill, so the groups sit at opacity 0 for 80 ms. | `app.css:2245`; `hub-ds/base.css:80-82` |
| DS-SIDE-D7 | Escape collides: the drawer's handler (`portal.js:530`) and the dock's (`dock.js:533-536`) both fire on one key press, and neither checks the target, so Escape in any input closes a panel. A third document-level owner is the task mount (`ui.js:7039`), so with a task open and a later panel beside it one press can close two things. Inner editors that cancel on Escape (the bookmark editor, `dock-marks.js:137`; AI rename, `dock-ai.js:772`) do not stop the dock's handler, which ignores `defaultPrevented`. (Third owner and inner editors added by the Astra cross-check.) | source |
| DS-SIDE-D8 | The rail item's focus ring is clipped at the left and right by the rail's `overflow-y: auto`. | `app.css:146`; `shots/sidebar/DS-SIDE-13/idle-focus-visible-1480-light.png` |
| DS-SIDE-D9 | (Decided fix: R33, #303.) At ≤ 900 with nothing open, the dock's tab strip is drawn below the viewport, so there is no way into any panel on a phone or small tablet. `.main` still reserves 40 px for it. At 390 it also widens `/clients/:client/docs/shared/` by 23 px. The same off-screen strip is the whole cause of two 390 captures' horizontal overflow: the design-system page's restored state (388 px, the strip's right edge at x 778) and the Projects board with the assignee editor open (187 px, the strip at x 577). (Added by the Astra cross-check, which had attributed them to the version grid and the editor popup.) | `dock.js:514`; `app.css:4459`, `:4520`, `:6029-6043`, `:6055`; SHELL D3, D4; DOCK D-1 |
| DS-SIDE-D10 | The fold button is last in the rail's tab order although it sits at the top, and has no `aria-expanded`. The drawer is not modal: no focus trap, no focus return, and the hamburger's label never changes. | `portal.js:510-531`, `:627`, `:631` |
| DS-SIDE-D11 | Both grips write localStorage on every mousemove instead of on mouseup. | `portal.js:672`; `dock.js:727`, `:750` |
| DS-SIDE-D12 | Both grips are mouse only and `aria-hidden`: no touch, pointer or keyboard path. | `portal.js:666-681`; `dock.js:705-711` |
| DS-SIDE-D13 | A plain click on any `[data-ask]` element stacks Client intelligence beside what is open, instead of replacing it (breaks §34.2). | `dock-ai.js:287`, `:889-891`; DOCK D-2 |
| DS-SIDE-D14 | The Clients head has two dividers (id · out · div · back · fwd · stamp · sync · div · X), and panels without a link-out have none. | `dock.js:610`; `dockboot.js:312-313`; `shots/sidebar/DS-SIDE-8/clients-default-1480-light.png` |
| DS-SIDE-D15 | Pre-paint drift: the hook counts every stored id while `layout()` counts only registered panels; it uses the stored rail width while `layout()` measures the rail; it skips the `maxPanelW` cap; and it does not replay `aa-dock-h`. Any of these can cause a first-frame jump. The dock also does not hear about rail collapse or drag (no event, no re-layout; `layout()` runs on window resize only, `dock.js:530`). The consequence: at 1550 wide with the rail collapsed, one 550 panel seats (1550 − 56 − 40 − 550 = 904 ≥ 836); expanding the rail to 224 leaves it seated with 736 px of content until the next resize, under the 836 floor. (Consequence added by the Astra cross-check.) | `route-home/index.html:18`; `dock.js:93-95`, `:202`, `:253-254`, `:320-323` |
| DS-SIDE-D16 | Stale documentation inside the code: "200ms" comments against the real 420 ms (`app.css:4851`, `:5611`); the `dock.js:30-42` header (a 280 px minimum, the rail as a track); wrong line cites (`dock.js:655`, `:663`; `dockboot.js:509`, `:897`). | source |
| DS-SIDE-D17 | **New (Astra cross-check):** crossing into ≤ 900 with several panels open leaves them all in the open set; `layout()` draws only the last (`dock.js:219`) and hides the rest (`:228`). A later open of one of the hidden ones through a resident door hits `openPanel`'s early return, which unhides it without closing the others or running `layout()` (`dock.js:776`), so two panels can draw at once on a phone. The one-panel rule is enforced only for fresh opens (`:794`). Normalise the set to one panel on entering the tier. | source; Astra reproduced it by running the functions |
| DS-SIDE-D18 | **Numbered by the Astra cross-check** (the DS-SIDE-10 entry already noted it): at ≤ 900 the grip drags height (`sheeted()`, `dock.js:145`, `:721-735`) but is drawn as a left-edge `col-resize` strip, because the top-edge `row-resize` rule lives only in the 901 to 1279 query (`app.css:5937-5940`). The height drag also starts from the whole panel box (`dock.js:723`) while writing a per-panel basis, so a stacked sheet jumps on the first move. | source |
| DS-SIDE-D19 | **New (Astra cross-check):** global dock history records only three residents' views: Clients' walk, Docs and Task (`dockboot.js:774`, `:795`, `:833`). The AI conversation and model, the Team person, the Notifications tab and the Projects filter and sort are not in an entry, and Team's conversation scroller is not the one `scrollerOf()` reads (`dock.js:927`). §34.7 promises the whole state, including "the active tab inside it" (`WIRING.md:2266-2270`). | source; test T-D24a |
| DS-SIDE-D20 | **New (fresh audit, FA-DOCK-36):** at 390 with a panel open, the phone strip holds nine 30 px items and eight 16 px gaps, 398 px in a 390 row, so Client intelligence and Close all are clipped at the edges. | FA-DOCK-36 shot; `app.css:6029-6055` |
| DS-SIDE-D21 | **New (fresh audit, FA-DOCK-37):** on the phone strip the divider under Client intelligence still draws as a horizontal hairline under its tab; on a row it belongs on the tab's right edge, as the sheet strip redraws it (`app.css:6021`). | FA-DOCK-37 |
| DS-SIDE-D22 | **New (fresh audit, FA-DOCK-30 to 35, its flag F-4):** the two horizontal strips run in opposite orders: the sheet strip is sorted by panel rank (Docs on the left) and the phone strip by the rail's `ORDER` (Client intelligence on the left). Settled: both follow the rail order (DS-SIDE-6 "Order"). | `dock.js:416-419`, `:188` |

---

## Rulings, decided

The "which edge" question is decided (#298: the dock), and so are the 380 floor (R39) and the phone strip (R33) on #303. Every lane ruling below is ruled (26 September 2026, the `DR` triage on #297's map) and written into its entry. Behaviour rulings (DR-54, DR-56, DR-57, and the behaviour halves of DR-55 and DR-60) are specified in `PLACEHOLDERS.md`, "Behaviour decided". DR-64 (seating order) was answered by the owner on 27 September (owner answer 8: float at the width asked for; T-D19 and its acceptance check), so no sidebar matter is open.

| # | Question | Recommendation | Ruled |
|---|---|---|---|
| R-SIDE-1 | Every section needs an icon in the collapsed rail (D1). Key the icons by route id in `routes.json`, not by path? | Yes. | DR-54 (behaviour): collapsed-rail icon per section, tracked as an icon field keyed by route id; do not copy the blank rail. |
| R-SIDE-2 | Should the drawer's close slide out (D5), and should the drawer be modal (focus in, trap, return)? | Yes to both. | DR-55 (decided): the rail drawer slides out on close (R-SIDE-2). Focus trap goes to the placeholder register. |
| R-SIDE-3 | Rail drag: follow the cursor live (no transition during a drag, as the dock does) and save on release? Snap to collapsed when dragged under 170? | Live and save on release: yes. Snap: no; keep collapse on the fold button only. | DR-56 (behaviour): rail width drag, live follow, saved on release as a per-person preference replayed before paint (section 34.4). |
| R-SIDE-4 | Keyboard: add a shortcut to collapse the rail, keyboard resizing on a focusable separator for both grips, and one Escape that closes only the topmost thing (drawer first, then the last panel) and never fires from inside an input? | Yes. `could be deliberate`: the mockup has no shortcuts at all. | DR-57 (behaviour): keyboard collapse shortcut, keyboard resize on both grips, one layered Escape; interaction only. |
| R-SIDE-6 | Only a seated panel glides; a floating one appears with no motion. Keep? | Keep. `could be deliberate`: the mockup records "PANELS NOW SIMPLY APPEAR". | DR-58 (decided): floating panels appear without motion, as drawn (WIRING.md:1412-1416; R-SIDE-6). |
| R-SIDE-7 | §34.1's rail order has no Notifications; `ORDER` puts it second. Update the law to match? | Yes. | DR-59 (decided): rail order CI, Notifications, Team, Clients, Projects, Task, Bookmarks, Docs (WIRING section 63.2; #121). |
| R-SIDE-8 | "Close" has three dialects: the panel X hovers to `--text`, the AI head's close hovers to `--accent` and rotates, and Close all hovers red. The AI panel also has its own head. One head and one close? | One head and one close (`--text` hover). Close all may stay red as the destructive "all" action. | DR-3 (decided): one panel head per WIRING section 34.3 for every panel incl. the assistant; X hovers `--text`, no rotate; Close all stays red. |
| R-SIDE-9 | Back to Clients: keep it as a filled primary button in the rail, and make it an anchor? Show it in the collapsed rail as an icon? | Keep the look, make it an anchor, and show a back icon when collapsed. | DR-60 (decided): Back to Clients stays filled primary; collapsed rail shows a back icon (R-SIDE-9). Anchor semantics go to the register. |
| R-SIDE-10 | The fold button overlaps the end of the wordmark at 224. | Move it clear of the logo. `could be deliberate`. | DR-61 (decided): fold button moved clear of the wordmark (defect; R-SIDE-10). |
| R-SIDE-12 | Rail widths: the DS says 220 / 58; the mockup builds 224 / 56. | 224 / 56, as built, and update the DS tokens. | DR-8 (answered): rail 224 / collapsed 56 as built, tokens updated; settled as R54 (the owner, C109 and C121-1). |
| R-SIDE-13 | The railmark slides in 220 ms and the tab underline in 420 ms. One speed? | Keep both. `could be deliberate`: the underline travels further. | DR-62 (decided): keep 220ms railmark and 420ms underline (R-SIDE-13). |

## Handed to other lanes

- **TOKENS:** the backdrop's literal `oklch(0 0 0 / .4)`; `--sidebar-w` and `--sidebar-collapsed-w` (unused); the tokens of the aliased dark ink (`#f8f8f8` resolves to `--on-dark` and three aliases).
- **PRIMITIVES:** `.btn--primary .btn--sm` (Back to Clients); the tooltip dialect shared by `.term` and `.dock__tablabel`; the count chip family (`.dock__n`, `.tmc__u`, `.cl__n`); the global focus ring and its clipping inside scroll containers.
- **COMPOSITES:** the appbar (SH-10 to SH-17, and SH-33 the client identity); the tab row and its underline (SH-18, SH-19); the page header (SH-20); every panel body and its residents (DOCK.md CL, CR, DC, BM, PJ, TM, NT, AI; TASKS.md DP, DT, TT); the empty-state dialects (DS-X1) inside panels; the walking panels' inner backs (CL-13, DC-20).
