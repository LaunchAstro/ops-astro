<!-- Public edition, generated from the private design-system source by ticket C82's build and checked by the real-names check before it crossed. Do not edit it here; the source changes and the copy is run again. Screenshots and review records stay private, so they are not linked. -->

# Primitive components (DS-PRIM)

Lane PRIMITIVES, design-system pass wave 1, 26 September 2026. Ticket: "Catalogue the primitive components (#290)" on the map "Ops Astro design system". This file answers to `docs/design-system/DIRECTION.md`: one home per element, no duplicates, every page element pointing at one canonical component.

## How to read this

- **Ids.** `DS-PRIM-<n>`, numbered from 1 and never reused. A page element points here by id; the table at the end maps every old baseline id (DS-K, DS-F, DS-X, DS-I in `docs/mockup-inventory/SHELL.md` section 1) to its new id.
- **Canonical, variant or drift.** Each entry names one canonical construction. Other ways the mockup draws the same thing are either **kept as a named variant** or listed under **Drift** with a proposal to drop. Where the mockup's difference might have been deliberate, the lane raised a ruling. Every one is now decided and written into its entry, by `DR` id (see "Rulings, decided" at the end). A **Proposal** under Drift is the canonical construction to build unless a `DR` ruling in the same entry says otherwise.
- **Styling values are measured**, from computed style in headless Chrome at 1480 wide (crop.mjs), light then dark. Token names are the matcher's names for the measured colour. Several tokens share one value (for example `--text`, `--rule` and `--text` are all black in light), so the name given is the one the source rule uses where the source was read, otherwise the first alias. Token values belong to lane TOKENS; this file only names them.
- **Shots** live in `../shots/prim/<folder>/<state>-<width>-<theme>.png`, each 40 KB or less. Forced pseudo-states (`hover`, `focus-visible`, `active`) apply to the element's own node only; parent-hover looks are not shown.
- **Construction** cites the mockup source (`dashboard-mockups`, paths relative to it) as evidence of intent, not as clean code. `A` = `assets/app.css`, `U` = `assets/ui.js`, `P` = `assets/hub-ds/primitives.css`, `B` = `assets/hub-ds/buttons.css`, `F` = `assets/hub-ds/forms-kit.css`, `L` = `assets/hub-ds/labels.css`, `T` = `assets/tokens.css`. Load order is T, then hub-ds (P, B, L, F), then A, so A wins at equal specificity.
- **Usages** are inventory element ids, grouped by the inventory file they come from. Two files reuse prefixes: `SH-` is the shell in SHELL.md and the shared workbench chrome in WORKBENCH.md; `CL-` is the dock clients panel in DOCK.md; `C-` is the clients board in BOARDS.md.

## How to read behaviour in this file

DIRECTION.md point 6: the look is canonical, in every state, token, size, motion and shot recorded here. What a control does in the mockup shows a capability Ops Astro must really have. The build makes it real and tracked (the event or record it creates), listed in [`PLACEHOLDERS.md`](../PLACEHOLDERS.md) under the control's catalogue id. The mockup's handlers, stored keys and demo-only states are evidence of intent, not the thing to build. Bugs are never copied. Until a capability is real, its control is drawn disabled with its reason (TICKET-PLAN R56), never live and dead. Behaviour the owner stated as law in their own words (WIRING.md) is specified exactly.

## The headline finding

The Hub design system snapshot under `assets/hub-ds/` declares most primitives (`.input`, `.field`, `.select`, `.switch`, `.check`, `.radio`, `.badge`, `.count`, `.dot`, `.u-pill`, `.btn--icon`, `.btn--danger`, `.btn--pill`, `.menu`, `.empty`, `.skeleton`, `.toast`), and **none of them has a single call site**. The mockup draws every one of those with a bespoke class in `app.css`. A live census of 40 routes and panels confirmed zero rendered matches for all of them. So the canonical component in each entry below is the mockup's live construction, not the dead hub-ds rule, unless the entry says otherwise.

## Index

| Id | Component | Canonical class | Shots |
|---|---|---|---|
| DS-PRIM-1 | Button | `.btn` + `--primary` / `--secondary` / `--ghost`, sizes `--sm`, `--lg` | yes |
| DS-PRIM-2 | Icon button (incl. close ×) | none live; proposed `.btn--icon` 26 square | yes |
| DS-PRIM-3 | Text input | `.tf__in` | yes |
| DS-PRIM-4 | Textarea | `.tf__ta` | yes |
| DS-PRIM-5 | Select | `.sel` / `.sel__btn` (wrapped from `<select>` at runtime) | yes |
| DS-PRIM-6 | Search box and keycap | `.cbd__field` | yes |
| DS-PRIM-7 | Checkbox | `.sbbox` | yes |
| DS-PRIM-8 | Radio | not drawn (gap) | none |
| DS-PRIM-9 | Switch | `.autosw` | yes |
| DS-PRIM-10 | Segmented control and facet | `.segmented`, `.facet` | yes |
| DS-PRIM-11 | Chip and pill | `.chip` + `--outline` / `--soft` | yes |
| DS-PRIM-12 | Badge (folded by DR-31 into DS-PRIM-25 and DS-PRIM-13) | `.ai__badge`, `.annotation__n` | yes |
| DS-PRIM-13 | Count | `.cbadge` (`countBadge`) | yes |
| DS-PRIM-14 | Dot and status line | `.sline` | yes |
| DS-PRIM-15 | Status mark (text, chip) | `statusPill` / `statusChip` | yes |
| DS-PRIM-16 | Avatar and avatar stack | `avFill` / `.sb__av`, `.viewers` | yes |
| DS-PRIM-17 | Icon and door mark | `fi fi-rr-*`, `.door__mark` | yes |
| DS-PRIM-18 | Tooltip and callout | `.term` | yes |
| DS-PRIM-19 | Menu and popover | `.sel__menu`, `.cbd__menu` | yes |
| DS-PRIM-20 | Table and cells | `.tablewrap` > `.table` | yes |
| DS-PRIM-21 | Card (base) | `.card` | yes |
| DS-PRIM-22 | Banner and tip | `.banner`, `.sectip` | yes |
| DS-PRIM-23 | Meter and progress | `.meter` | yes |
| DS-PRIM-24 | KPI number | `.stat` (`kpiSm`) | yes |
| DS-PRIM-25 | Marker, tag, stamp, index, freshness | `.marker`, `.u-tag`, `.stamp`, `.index`, `button.fresh` | yes |
| DS-PRIM-26 | Link and door link | `.chlink`, `doorMark` | yes |
| DS-PRIM-27 | Divider and rule | `hr.rule`, `.cbd__div` | yes |
| DS-PRIM-28 | Empty state | `.cbd__empty` (block) + inline variant | yes |
| DS-PRIM-29 | Loading state | none exists (gap, proposed) | none |
| DS-PRIM-30 | Error state | `.banner--bad` + proposed field error | yes |
| DS-PRIM-31 | Disclosure chevron | `.alert__toggle` | yes |

## Shared state rules (apply to every interactive primitive)

- **Focus.** The global rule `:focus-visible { outline: none; box-shadow: var(--focus-ring) }` (`T:43`) draws a 2px `--bg` halo and a 4px `--accent` ring (dark: the halo is the void). Buttons add their own 2px `--accent-ring` outline at 1px offset (`P:34`), so a focused button carries **two rings** (see the `focus-visible` shots of DS-PRIM-1). Ruled (DR-1): the global ring only, one `--focus-ring` value; the button outline is dropped.
- **Hover.** Controls darken their ink to `--text` or move their border to `--border-strong` or `--accent`. There is no shared hover token; the entries record each.
- **Motion.** `--ease` `cubic-bezier(0.16, 1, 0.3, 1)` everywhere. Buttons transition background, colour, border and transform over 220 ms (`--dur-1`); chips, facets, markers and table rows over 120 ms (`--dur-fast`); cards transition border colour over 220 ms (`A:2257-2259`).
- **Disabled.** Opacity .6 and a not-allowed cursor (`P:35`), except primary buttons (outline, see DS-PRIM-1) and switches (dashed border).
- **Radius.** Everything is square (radius 0) except chips (`--radius-pill`), avatars for people (50%) and nothing else.
- **Unwired controls** (`[data-unwired]`, `A:916-922`) render at opacity .55 with a hatch. That marks a placeholder, not a look to copy: the build makes the control real and tracked (`PLACEHOLDERS.md`, under the control's id), or draws it disabled with its reason until it is (TICKET-PLAN R56). It has a defect worth knowing: the hatch's `background` shorthand wipes a primary button's fill, so an unwired primary is near-invisible (shot `prim01-primary-unwired`).

---

## DS-PRIM-1 Button

- **Purpose.** The one text button for every action.
- **Anatomy.** Inline-flex box; optional leading icon (`fi` glyph), label; gap 6.6 px; 1px border (transparent unless the variant draws one).
- **Variants kept.**
  - `--primary`: ink fill, paper text. The main action on a surface.
  - `--secondary`: 1px ink outline, ink text. Inverts to an ink fill on hover.
  - `--ghost`: no border, `--text-2` text; hover turns the text `--accent`.
  - Sizes: `--sm` (27 tall, label 12) is the house default and is on 175 of about 180 buttons; `--lg` (43 tall, label 15) is the portal call to action. The unsized DS base is 32 tall and survives only in bespoke buttons (see Drift).
  - `pressed` (ink fill, paper text) for a toggle button, as `.cbd__preset.is-on` and `.crm__kinds .btn[aria-pressed]` draw it. Kept by DR-20: it is the filter-preset toggle (`A:12279` comment).
  - `--md` (38 tall, added by DR-21): pairs a button with a 38 input; replaces the six stretched sizes listed under Drift.
  - `--text`: a borderless text button (`.alert__x` "Dismiss", `.tt__more`, `.sb__relink`, `.cbd__lnk`); underline on hover.
- **States** (measured on `--primary`, `--secondary`, `--ghost`):
  - default, hover, focus-visible, active, disabled for all three; `pressed` for the preset toggle.
  - Primary hover and active: fill `--accent`, text `--accent-ink`. Active adds `translateY(1px)`.
  - Secondary hover and active: fill `--text`, text `--bg`.
  - Ghost hover and active: text `--accent`, no fill.
  - Focus-visible: the global ring only (DR-1). The mockup also draws a 2px `--accent-ring` outline at 1px offset (the double ring); that outline is not built.
  - Disabled: secondary and ghost go to opacity .6; primary becomes a `--border` outline with `--text-muted` text and no fill (`A:2012`, overriding the grey fill at `P:39`). The outline is the ruled look (DR-22).
- **Styling.**

  | Property | `--sm` | `--lg` |
  |---|---|---|
  | Height | 27 | 43 |
  | Padding | 0 11.4px | 12.75px 22.5px |
  | Type | Funnel Sans 12/12 500, tracking −0.12px | Funnel Sans 15/15 500, −0.15px |
  | Radius | 0 | 0 |
  | Primary colours | fill `--text` (light #000, dark #f8f8f8), text `--bg` (light #fff, dark void) | same |
  | Secondary colours | border and text `--text` | – |
  | Ghost colours | text `--text-2` (light #6b635d, dark on-dark 72%) | – |
  | Motion | background, color, border-color, transform 220 ms `--ease` | same |

- **Shots.**

  | Shot folder | default | hover | focus-visible | active | disabled | is-on |
  |---|---|---|---|---|---|---|
  | `prim01-primary` | light · dark | light · dark | light · dark | light · dark | light · dark | – |
  | `prim01-secondary` | light · dark | light · dark | light · dark | light · dark | light · dark | – |
  | `prim01-ghost` | light · dark | light · dark | light · dark | light · dark | light · dark | – |
  | `prim01-lg` | light · dark | light · dark | light · dark | light · dark | – | – |
  | `prim01-preset` | light · dark | light · dark | light · dark | – | – | light · dark |
  | `prim01-alert-x` | light · dark | light · dark | light · dark | – | – | – |
  | `prim01-primary-unwired` | light · dark | light · dark | light · dark | light · dark | light · dark | – |

- **Construction.**
  - `.btn` geometry `P:23` (32 tall, radius 0) and type and padding `B:42`; variants `--primary` `B:63`, `--secondary` `B:67`, `--ghost`/`--tertiary` `B:77`; sizes `--sm` `P:91`/`B:109`, `--xs` `P:94`/`B:114`, `--lg` `B:121`; active `B:60`; focus `P:34`; disabled `P:35`, primary disabled `P:39` overridden by `A:2012`.
  - No builder in `U`; buttons are typed into HTML and template strings.
  - Pressed toggle: `.cbd__preset` `A:9238` (pressed defined three times: `A:9250`, `A:12299`, `A:12258`/`A:12308`), `.crm__kinds .btn[aria-pressed]` `A:6764`.
- **Usages.**
  - SHELL.md: DS-K1, DS-K2, DS-K3, SH-17 (bespoke `.appbar__timer`), SH-22 (`button.marker.fresh`, see DS-PRIM-25), SH-30, SH-61.
  - AGENCY.md: AG-K10, AG-K13, AG-P4, AG-P13, AG-P25, AG-P27, AG-E12, AG-E16, AG-E26, AG-C3, AG-C7, AG-C18, AG-C19, AG-C23, AG-C54, AG-C57, AG-C60, AG-C61, AG-S3, AG-S4, AG-S8, AG-X21, AG-X23.
  - BOARDS.md: B-08, P-05, P-06, P-08, P-48, P-49, P-60, R-07, R-08, R-09, R-12, L-02, C-07, C-08, C-33, C-42, C-44, M-06, V-03, V-06.
  - CLIENT.md: BR-09, BR-12, BR-15, BR-16, BR-23, BR-26, BR-45, BR-47, BR-50, RC-07, RC-09, RC-10, RC-11, WK-01, WK-02, WK-03, WK-04, WK-05, WK-07, WK-20, WK-21, WK-23, MO-01, MO-09, MO-13, MO-14, BD-01, BD-02, BD-03, BD-06, DSY-09, DSY-11, DR-01, DR-04, AC-03, AC-04, AC-05, AC-09, AC-10, AC-11, AC-14, AC-17, AC-19.
  - DOCK.md: CR-11, CR-20, CR-22, CR-24, CR-26, DC-03, DC-07, DC-11, DC-20, BM-01, BM-08, TM-05, AI-12.
  - TASKS.md: DT-06, DT-10, DT-11, DT-13, DT-21, DT-23, DA-03, DA-06, DA-07, DN-03, DN-04, DP-20c, TT-06.
  - PORTAL.md: PH-12, PH-18, PW-01, PW-02, PW-05, PW-06, PM-01, PP-03, PP-09, PP-11, PP-16, PP-17, PP-20, PLB-02, PLB-04, PLB-05, PLB-08, PLD-02, PLD-04, PLV-07, PAI-01, PAI-02, PAI-03, PAH-02, PAD-01, PAD-02, PAD-04, PAP-02, PAC-04, PC-02, PC-08, PC-12, PB-01, PB-04, PB-06, PB-07, PB-09.
  - WORKBENCH.md: SH-04, SH-05, SH-15, SH-16, CN-W07 to CN-W12, CN-M03, CN-M05, CN-M06, CNX-M03, CNX-M05 to CNX-M08, CNX-M10, CNX-M11, TL-M05 to TL-M08, OB-M03 to OB-M05, FM-M05 to FM-M08, SS-M05 to SS-M07, SS3-M05 to SS3-M07, SI-W02, SI-W04, SI-M05 to SI-M08, SI-M10, SI-M15, SIR-M05 to SIR-M08, SIR-M10, SIR-M16, GA-W05, GA-M03 to GA-M05, GA-M11, MA-W03, MA-M03 to MA-M05, MA-M08, TS-M02 to TS-M04, LR-M05 to LR-M07, CL-W03, CL-M05 to CL-M08, CL-M10, EM-W04, EM-M05 to EM-M08, EM-M12, FN-M05 to FN-M07, RV-M05 to RV-M07, WP-M05 to WP-M08, WPO-M05 to WPO-M08.
- **Drift.**

  | Where | What differs | Proposal |
  |---|---|---|
  | `.cbd__preset` `A:9238`, `.cbd__mode` `A:10609` (B-07, B-09) | Sans 13, `--border-strong` outline on paper, 28 tall | Keep as secondary `pressed` toggle (DR-20) |
  | `.dp__q` `A:2434`, `.bk__add` `A:3368` (BR-23) | Mono, 1px border, accent hover | Drop to `--secondary --sm` |
  | `.aip__chip` `A:707` | Prompt suggestion drawn as a square button | Move to DS-PRIM-11 as the suggestion chip |
  | `.slot` `A:3408`, page-local `.mtype button` (`client-portal/contact/book/index.html:18`) (PB-04, PB-06, PB-07) | Mono .8rem single-select grid, `aria-pressed` | Now DS-COMP-38 Calendar and date grid (`slot grid`, `meeting-type tile`, `day list`), which names these classes; retargeted by lane RECONCILE-LOOK |
  | `.tt__more` `A:5248`, `.sb__relink` `A:5556`, `.alert__x` `A:8021`, `.cbd__lnk` `A:7116`, `.crm__logbtn` `A:6812` (CR-22, CR-24, CR-26, DC-07, DT-06, DT-13, TT-06, PP-11) | Borderless text buttons, each with its own size (11.5 to 13 px) and case | Keep one `--text` variant; drop the rest |
  | `.hero__edit` `A:6157` | Mono upper-case on the hero, hard-coded `white` | Drop; `--ghost` on the hero ink |
  | `.appbar__timer` (`assets/portal.js:1149`) (SH-17) | App-strip text button | Handed to COMPOSITES (app strip) |
  | Stretched sizes: AG-C54 46×54, DT-10 245×38, DT-11 45×38, DT-21 52×39, PP-20 and V-06 52×33 | Height taken from a neighbouring input | Add one `md` 38 size to pair with inputs (DR-21) |
  | CN-M06, SI-M15 (32 tall, padding 14.95), GA-M11 and AG-K13 (padding 4.8) | Unsized base or overridden padding | Drop to `--sm` |
  | PP-09 (`--text-muted`, looks disabled but is live), PB-09 (primary drawn as an outline), PB-07 (opacity .4 plus line-through) | Three private disabled looks | Drop; use the one disabled state |
  | P-05 | `a.btn--secondary` with link underline | Drop the underline |
  | Unused: `--danger` `B:86`, `--pill` `B:92`, `--tertiary`, `--hero` `P:46`, `--round` `P:102`, `[data-state=confirm]` `P:82`; `--xs` has one use (`U:3874`) | Declared, never drawn | Drop, except keep `--danger` as a named gap for destructive confirms |

- **Defects not to copy.**
  - Double focus ring (`P:34` outline plus `T:43` box-shadow).
  - Primary disabled defined twice (`P:39` grey fill, `A:2012` outline); `A` wins by order.
  - Three competing `.cbd__preset.is-on` rules resolved by source order.
  - The pressed preset loses its keyboard focus ring: `.cbd__preset.is-on` sets `box-shadow` (`A:9250`, then `none` at `A:12299`) at higher specificity than the global `:focus-visible` ring (`T:43`), and no preset focus rule replaces it (built at `assets/board.js:361`). Give pressed and unpressed presets the same ring. (Added by the Astra cross-check.)
  - Hard-coded `white` at `A:6149`, `A:6161`, `A:6162`, `A:6164`.
  - Buttons that navigate (SH-30, a `<button>` that cannot be middle-clicked) and buttons with no handler (AG-K10 Dismiss, AG-E16, RC-10, RC-11, DA-06, GA-M11, CNX-M06, CNX-M08, SI-M15, the SH-16 Dismiss on every workbench card). Those are placeholders: build the capability each shows (`PLACEHOLDERS.md`, DS-PRIM-1), or draw it disabled with its reason until it can (TICKET-PLAN R56; Roll back DA-06 is R78); never live and dead.
  - The unwired hatch wiping a primary's fill (AC-03 Pay now).

## DS-PRIM-2 Icon button (including close ×)

- **Purpose.** A square, icon-only action: close, dismiss, ask the agent, open, expand, edit, remove.
- **Anatomy.** A square box with one centred glyph; no border; an accessible name in `aria-label` or `title`.
- **Variants kept.**
  - Default, 26 square: `.dpanel__x`, `.alert__toggle`, `.askbtn`. Glyph `--text-muted`, hover `--text`.
  - Compact, 22 square (BR-10, PP-19, DT-17 `.msg__b`, V-05). Kept for dense rows (DR-23).
  - `--accent` hover: the ask sparkle (`.askbtn`) turns `--accent` and scales to 1.12 on hover (120 ms). Deliberate: "the agent asks" (WIRING §90).
  - `--danger` hover: remove (`.dp__drop` `A:4548`).
  - `--reveal`: hidden (opacity 0) until the host row is hovered (CL-08 to CL-10, BM-03, BM-04, CR-04, AI-07, DT-12, DT-17, PP-19; `A:6546-6548`). Kept above 900; shown at rest below 900 and on focus (DR-24, TICKET-PLAN R37).
- **States.** default, hover, focus-visible (global ring only), active (no change except `.banner__x`, which keeps its hover ink). No disabled rule except `.cbd__ico` (`A:7124`) and `.dpanel__nav` (opacity .4, `A:12390`).
- **Styling.** 26×26 (the banner close is 24×24); glyph 14 to 16.8 px; colour `--text-muted` (light #8c857f, dark 55 percent (DR-10 fold; the mockup drew 46)) to `--text` on hover; transparent ground; radius 0; no transition except the ask sparkle (color and transform 120 ms `--ease`).
- **Shots.**

  | Shot folder | default | hover | focus-visible | active | expanded |
  |---|---|---|---|---|---|
  | `prim02-dpanel-x` | light · dark | light · dark | light · dark | – | – |
  | `prim02-banner-x` | light · dark | light · dark | light · dark | light · dark | – |
  | `prim02-askbtn` | light · dark | light · dark | light · dark | – | – |
  | `prim02-alert-toggle` | light · dark | light · dark | light · dark | – | light · dark |

- **Construction.**
  - DS canon `.btn--icon` `P:97` + `B:128`, `.btn--icon.btn--sm` `P:98`, `.btn--round` `P:102`: zero call sites.
  - Live: `.banner__x` `A:605` (hover `A:611`), `.dpanel__x` `A:4474` (redefined `A:5584`), `.askbtn` `A:809` (builder `U:977 askIcon`), `.alert__toggle` `A:8605`, `.dp__drop` `A:4548`, `.aip__x` `A:2451`, `.bk__x` `A:3362` (bordered), `.lasset__x` `A:3939`, `.vnote__x` `A:3900`, `.bkpop__x` `A:7735`, `.ps__x` `A:8403`, `.cmtab__x` `A:10241`, `.tgs__x` `A:11168`, `.conn__xbtn` `A:4294`, `.msg__b` `A:5699`, `.cbd__ico` `A:7124`, `.brief__play` `A:1507`, `.aip__act` `A:1737`, `.cl__gb` `A:11586`, `.crm__ic` `A:6662`, `.stg__rb` `A:7297`, `.navtoggle` `A:217`.
- **Usages.**
  - SHELL.md: DS-K3 (`--icon`), DS-K9 (`.banner__x`), SH-7 (`.railfold`), SH-11, SH-12, SH-23 (`.navtoggle`), SH-25, SH-27.
  - AGENCY.md: AG-K2, AG-K5, AG-K7, AG-K8, AG-P5, AG-P7, AG-E4, AG-E6, AG-E12, AG-E15, AG-C4, AG-C8, AG-C53, AG-S5, AG-S7, AG-S15.
  - BOARDS.md: B-04, B-10, B-12, B-13, P-04, P-33 (`.cbd__go` 24), P-36, C-23, C-24 (`.stg__rb--sm` 22), S-05 (`.stg__rb` 29), G-01, G-02, R-11, V-05.
  - CLIENT.md: BR-10, BR-11, BR-17, BR-28, BR-30, BR-31, BR-35, BR-36, BR-55, BR-57, MO-02, TR-02, VO-05, DSY-12.
  - DOCK.md: DK-02, DK-06, DK-09, DK-11, DK-12, DK-13, CL-01, CL-03, CL-04, CL-08, CL-09, CL-10, CL-11, CL-13, CR-04, DC-08, BM-03, BM-04, PJ-01, AI-03, AI-04, AI-05, AI-07, AI-08.
  - TASKS.md: DP-02 to DP-07, DP-09, DP-10, DP-20a, DP-20d, DP-28, DP-30, DT-12, DT-17, TP-05.
  - PORTAL.md: PH-02, PH-14, PW-04, PM-03, PM-06, PT-02, PT-03, PT-04, PP-04, PP-19, PG-02, PLB-03, PLV-02, PLV-04, PLV-06, PLK-02, PLK-05, PAC-02, PC-03, PB-02.
  - WORKBENCH.md: SH-06, SH-13, SH-14, CN-W08, and the `-M01`, `-M03`, `-M04`, `-M06` modal controls on every tab (CN, CNX, TL, OB, FM, SS, SS3, SI, SIR, GA, MA, TS, LR, CL, EM, FN, RV, WP, WPO).
- **Drift.**
  - Close × sizes 1.2, 1.35, 1.5, 1.6 and 1.75rem, with hover inks `--text`, `--accent` and `--danger` (DK-13, AI-05, DC-08, BM-04, AI-07, DP-28 `.tgs__x` 9×11, SH-06). Proposal: one 26 square close with `fi-rr-cross-small`, hover `--text`; drop the rest.
  - Glyph: 15 buttons type a literal "×", 9 use `fi-rr-cross-small` (`U:4945`, `U:6119`). Proposal: the icon.
  - `.bk__x` and `.stg__rb` draw a border on a paper ground. Kept as drawn for steppers (S-05, C-24): decided at build-ready, the look is canonical (DIRECTION point 6).
  - The edit pencil hovers `--danger` because it shares `.dp__drop` with remove (DOCK D-17, `A:4552`). Drop.
  - DOCK D-26: `.dpanel__nav` borrows `.dpanel__x`; CL-03 and DP-02 borrow `.dpanel__new`. Name them as this component.
- **Defects not to copy.** `.vnote__x` paints as the native grey outset button because it has no reset (VO-05, PLV-06, `A:3900`). Only `.lasset__x`, `.stg__rb` and `.dock__closeall` have focus rules of their own. `outline: var(--focus-ring)` at `A:862` and `A:1038` is invalid (the token is a box-shadow list), so those controls survive only on the global ring.

## DS-PRIM-3 Text input

- **Purpose.** One line of typed text.
- **Anatomy.** A field box with placeholder; an optional label above (mono marker style, DS-PRIM-25) and an optional hint or error line below (DS-PRIM-30).
- **Variants kept.**
  - Default: paper ground (`.tf__in`, `.aip__input`, `.dcs__search`).
  - `--sunk`: dropped by DR-25 (one paper field ground on both faces). The portal forms and the composer draw a `--surface-2` ground (`client-portal/contact/index.html:17-24`); the build draws paper.
  - `--inline`: the rename-in-place and underline-only inputs (DP-08 `.sb__name` in the display face, DT-02 underline only, `.sbadd__in` `A:5224`). Kept as a named variant for titles edited in place (TASK-PAGE DN-01 uses it).
- **States.** default, hover (no change on any live input), focus (border to `--accent`, no ring), disabled (no live rule; the hub `F:87` dashed border is dead). No invalid state anywhere (see DS-PRIM-30).
- **Styling.** 38 tall; padding 7.2px 12px (portal 8.8px 12px); Funnel Sans 14/21.7 400 (portal 14.4, placeholder in `--text-muted`); text `--text`; ground `--bg` (dark: the void) or `--surface-2`; border 1px `--border` (light black 12%, dark on-dark 10%); focus border `--accent` #745cee; radius 0; no transition.
- **Shots.**

  | Shot folder | default | hover | focus |
  |---|---|---|---|
  | `prim03-tf-in` | light · dark | light · dark | light · dark |
  | `prim03-aip-input` | light · dark | – | light · dark |
  | `prim03-input` | light · dark | light · dark | light · dark |

- **Construction.** `.tf__in` `A:2357`; `.aip__input` `A:713`, redefined at `A:4219` as paper; `.bk__in` `A:3331`; `.askbox__in` `A:1023` (borderless); `.composer input` `A:3044`; page-local `.biz-input` (`client-portal/account/index.html:32`), `.form input` (`client-portal/contact/index.html:19`), `.addgrid input` (`client-portal/connections/index.html:26`). Dead canon: `.input` `P:194` then `F:80-104`, `.field` `P:222`, `.field__label` `F:54`, `.field__hint` / `.field__error` `F:67-74`.
- **Usages.**
  - SHELL.md: DS-K16.
  - AGENCY.md: AG-C54, AG-C61.
  - BOARDS.md: R-12, V-06.
  - CLIENT.md: BR-12, BR-18, BR-23, BR-45, AC-10.
  - DOCK.md: CR-02, CR-03, CR-23 (contenteditable), CR-27, BM-05, BM-06, BM-07, AI-06, AI-11, TM-05.
  - TASKS.md: DP-08, DP-26, DP-31 (label), DT-02, DT-11, DT-12, DT-21, DN-01.
  - PORTAL.md: PP-20, PC-05 (label), PC-06, PAD-01.
  - WORKBENCH.md: CN-W07 (password), SI-M12, SIR-M13.
- **Drift.** Paddings .3 to .55rem; sizes .85, .875, .9rem; grounds paper, surface and surface-2 (SI-M11 select on surface-2 beside SI-M12 input on surface). Drop all but the two grounds above.
- **Defects not to copy.** PP-20's composer input renders in Arial and truncates its placeholder (`A:3044`). BR-45 has no focus outline (`A:1028`). Focus rules use `:focus`, not `:focus-visible`, which is right for text entry; keep. The dead hub-ds `.input` focus (ink border) contradicts the live accent border: the live one wins.

## DS-PRIM-4 Textarea

- **Purpose.** Several lines of typed text.
- **Anatomy.** As DS-PRIM-3, with a resize grip and a minimum height.
- **Variants kept.**
  - Sans (default): `.dp__field`, `.connnote__field`, portal `.form textarea`.
  - Mono: the task brief `.tf__ta` (Chivo Mono 12), and the Library ▸ Design system "Replace it" note (Chivo Mono 13, FA-CLIENT-60). DR-26 settles both: Sans everywhere except the Agent brief. Deliberate per the comment at `A:2563`, but TASKS D-09 notes the same field is Sans 14 on the task page (TT-01): settled by DR-26 and TICKET-PLAN R60.
- **States.** default, hover (no change), focus (border `--accent`). No disabled or invalid state.
- **Styling.** Padding 7.2px 8.8px (dock) or 8.8px 12px (portal); Funnel Sans 14/21 (portal 14.4); border 1px `--border`; ground `--bg` or `--surface-2`; focus border `--accent`; radius 0; min-heights 3.4rem, 3.6rem, 6rem and 120px (drift).
- **Shots.**

  | Shot folder | default | hover | focus |
  |---|---|---|---|
  | `prim04-connnote` | light · dark | light · dark | light · dark |
  | `prim04-textarea` | light · dark | light · dark | light · dark |

- **Construction.** `.tf__ta` `A:2570`; `.bk__ta` `A:3335`; `.dp__field` `A:4532` (patched `A:4613`); `.connnote__field` `A:4314`; `.vnf .tf__ta` `A:3957`; `.rec__discuss textarea` `A:525`; `.paction__editor textarea` `A:1162`; page-local `.form textarea` (`client-portal/contact/index.html:23`). Dead canon `textarea.input` `P:215`.
- **Usages.**
  - AGENCY.md: AG-E16.
  - BOARDS.md: P-48, R-11.
  - CLIENT.md: BR-25, RC-09, DSY-08 (`.bk__ta`), VO-06.
  - DOCK.md: DC-01.
  - TASKS.md: DP-34, DP-35, DT-17.
  - PORTAL.md: PP-19, PLV-07, PC-07.
  - WORKBENCH.md: CN-W11, CNX-M09.
- **Drift.** Six minimum heights; two families. Decided: min-height 3.6rem for notes, 6rem for briefs; Sans, with mono only for the Agent brief (DR-26, TICKET-PLAN R60).
- **Defects not to copy.** `.rec__discuss textarea` focuses with a 1px accent outline, unlike every other field.

## DS-PRIM-5 Select

- **Purpose.** Choose one value from a short list.
- **Anatomy.** A trigger shaped like DS-PRIM-3 with the current value and a caret on the right; opens a DS-PRIM-19 option menu.
- **Variants kept.** Field select (default); `--ghost` in the AI dock header (`.aip__hmodel .sel__btn` `A:10440`); `--inline` in table cells (`.cbd__cell .sel__btn` `A:7439`, paper ground). `.crm__edsel` `A:6750` (dotted accent underline, gradient caret) is drift.
- **States.** default; hover (border `--border-strong`); focus-visible and open (border `--accent`; focus-visible also draws the global ring); disabled (`A:1818`, on the native element only).
- **Styling.** 37 tall; padding 8.8px 12px; gap 12; Funnel Sans 14.4/17.28; text `--text`; ground `--surface-2` (portal) or `--bg` (task form); border 1px `--border`; caret a CSS border triangle; radius 0.
- **Shots.**

  | Shot folder | default | hover | focus-visible | open |
  |---|---|---|---|---|
  | `prim05-select` | light · dark | light · dark | light · dark | light · dark |

- **Construction.** Every `select:not([data-native])` is wrapped at runtime by `wireSelects` (`assets/portal.js:755-860`) into `.sel` / `.sel__btn` (`A:1941`, hover `A:1948`, focus and open `A:1949`, caret `A:1950`). Bare `select` styles `A:1803-1818`. Dead canon: `.select` `P:668`, `select.select` `P:679`, `.select__btn` / `__menu` / `__opt` `F:267-339`.
- **Usages.**
  - AGENCY.md: AG-K17 (`.sel__btn` 240×37), AG-C48, AG-C54, AG-C61.
  - BOARDS.md: P-37, P-64, P-65.
  - CLIENT.md: BR-19, BR-20 (`.dp__btn`), BR-22, BR-23, BR-24, VO-06.
  - DOCK.md: DC-09, DC-10, CR-12, CR-13, AI-02.
  - TASKS.md: DP-18, DP-19, DP-20 (`.dp__btn`), DP-21 to DP-25.
  - PORTAL.md: PLV-07, PLV-08, PC-05.
  - WORKBENCH.md: SH-05, SI-W04, SI-M11, SI-M13, SI-M14, SIR-M12, SIR-M14, SIR-M15.
- **Drift.** Three select systems (`P`, `F`, `A`) plus the runtime wrapper; the native `select` uses a gradient chevron while `.sel__btn` uses a border triangle; `.addgrid select` is mono (`client-portal/connections/index.html:31`). Keep the wrapper; drop the rest.
- **Defects not to copy.** ArrowDown commits the choice instead of moving (`assets/portal.js:860`); Escape bubbles and closes the host panel (TASKS D-32, DOCK D-22). DP-27 swallows Escape correctly: copy that one. The enhancement drops native disabled state: a disabled `<select>` or `<option>` is not carried to the new button or options, and `choose()` does not refuse a disabled option (`assets/portal.js:764-860`). (Added by the Astra cross-check.)

## DS-PRIM-6 Search box and keycap

- **Purpose.** Type to find or filter within a surface.
- **Anatomy.** A field (DS-PRIM-3 geometry) with a leading search glyph (`fi-rr-search`), placeholder, optional token chips (DS-PRIM-11 filter tags) inside, optional trailing keycap.
- **Variants kept.**
  - Board search `.cbd__field` (default): 34 tall, paper, leading icon, focus shows on the wrapper (`:focus-within`).
  - Dock panel search (`.dcs__search`, `.cl__find .tf__in`, `.tsearch` with tags): DS-PRIM-3 geometry.
  - App-strip search: a dark variant on the app chrome with the ⌘K keycap. It is unwired (the Hub wires ⌘K at port): a placeholder for a real search, listed in `PLACEHOLDERS.md` under DS-PRIM-6. The control is this component. Its placement belongs to the app strip (COMPOSITES).
  - Keycap: Chivo Mono 10.88 upper-case, 1px mixed border, padding 0 4px, radius 0.
- **States.** default, hover (none), focus (border `--accent` on the field or wrapper). The app-strip box is at opacity .55 because it is unwired. That dim is the placeholder mark, not a state to build.
- **Styling.** Board: 34 tall, padding 4.8px 8.8px, gap 7.2, Sans 14, border 1px `--border`, ground `--bg` (dark `--surface`). Dock: 37 to 38 tall, Sans 13 to 14. App strip: 32 tall, Sans 13, ground white 7% over `--app-chrome`, border app-ink 12%, ink app-ink 50%.
- **Shots.**

  | Shot folder | default | hover | focus |
  |---|---|---|---|
  | `prim06-board-search` | light · dark | light · dark | light · dark |
  | `prim06-dcs-search` | light · dark | – | light · dark |
  | `prim06-appbar-search` | light · dark | light · dark | – |
  | `prim06-kbd` | light · dark | – | – |

- **Construction.** `.cbd__field` `A:7088`, input `A:7095`, `:focus-within` `A:7090`, ring removed at `A:7097` (board built at `assets/board.js:160`); `.tsearch__tags` / `__in` `A:6515`/`A:6518` (`assets/dock-tasks.js:377`); `.dcs__search` `A:7465` (`assets/dock-notes.js:65`); `.cl__find .tf__in` `A:6463` (`assets/dock-clients.js:307`); `.appbar__search` `A:2715`, `.appbar__kbd` `A:2722` (built at `assets/portal.js:1129`). No DS canon.
- **Usages.**
  - SHELL.md: SH-14.
  - BOARDS.md: B-01, B-05, P-02, C-01, C-30, C-40, R-01, L-01.
  - DOCK.md: CL-05, DC-14, PJ-02.
  - TASKS.md: surface S9 (list entry).
  - PORTAL.md: PF-07, PP-12.
- **Drift.** L-01 `#actQ` is 582×38 with its own shape; DC-14 has its own 13 px dress; paddings .3/.45rem and grounds differ across the four dock searches. Drop to the two variants.
- **Defects not to copy.** The board search removes the global ring (`A:7097`) and relies on `:focus-within`; fine, but keep one way.

## DS-PRIM-7 Checkbox

- **Purpose.** Tick an item done, or pick several.
- **Anatomy.** An 18 square button with `role="checkbox"` and `aria-checked`; the tick is a "✓" glyph.
- **Variants kept.** Default 18. The task-list size (`.tl__row .sbbox` `A:5131`). Checked is an **outline**: `--accent` border and an `--accent` tick, no fill. Deliberate (`U:4574` comment), and it follows the house rule that status is never a fill.
- **States.** default (unchecked), hover (border `--accent`), focus-visible (global ring), checked. No disabled rule.
- **Styling.** 18×18; border 1px `--border-strong` (light ink 32%, dark on-dark 20%); ground `--bg`; glyph Sans 11.2 in `--accent`; radius 0.
- **Shots.**

  | Shot folder | default | hover | focus-visible |
  |---|---|---|---|
  | `prim07-sbbox-off` | light · dark | light · dark | light · dark |
  | `prim07-sbbox-on` | light · dark | – | – |

- **Construction.** `.sbbox` `A:3807`, hover `A:3813`, checked `A:3814`; builder `U:4576 sbBox`, bypassed by hand-written markup at `assets/dock-tasks.js:356` and `assets/projectsboard.js:1203`. Dead canon `.check` / `.check__box` `F:130`/`F:141` (checked fills with ink).
- **Usages.**
  - BOARDS.md: P-30.
  - DOCK.md: PJ-06.
  - TASKS.md: DP-16, DP-17, DT-03, TP-08 (inert), TT-02 (inert).
- **Drift.** `.wf__mark` `A:12636` is a 1.5px tick box with a tone: it is a status mark (DS-PRIM-15), not a control.
- **Defects not to copy.** Six inert `span.sbbox` ticks keep `cursor: pointer` (TASKS D-08). The builder is bypassed in two files. The ✓ is a text glyph, not an icon.

## DS-PRIM-8 Radio

**Retired 27 September 2026 (AUDIT-RECONCILE, OP-24).** Nothing drawn, no page, register row or ticket uses it; single choices are DS-PRIM-10; the build adds a radio only when a ticket needs one. Kept below as evidence only; not built, and no page points here.

- **Purpose.** One choice from a set, shown as a list.
- **Status.** **Not drawn anywhere.** Single-choice groups use `aria-pressed` buttons (DS-PRIM-10). The hub `.radio` / `.radio__dot` (`F:164-195`) has zero call sites.
- **Proposal.** Do not build a radio until a surface needs a vertical list of choices. Single choice stays DS-PRIM-10. Recorded as a gap, not a component.
- **Usages.** None in any inventory.
- **Shots.** None (nothing to shoot).

## DS-PRIM-9 Switch

- **Purpose.** Turn a standing setting on or off, with immediate effect.
- **Anatomy.** A 42×20 square track with `role="switch"` and a square knob (`.autosw__k`).
- **Variants kept.** One size.
- **States.** off, on, hover (border `--border-strong`), focus-visible (border `--accent` plus the global ring; its own rule sets `outline: none`), disabled (dashed border, not-allowed cursor).
- **Styling.** 42×20, padding 2; border 1px `--border` (off) or `--success` (on); ground `--bg`; knob `--success` fill when on, `--border-strong` outline when off; radius 0.
- **Shots.**

  | Shot folder | default | hover | focus-visible | disabled |
  |---|---|---|---|---|
  | `prim09-autosw-off` | light · dark | light · dark | light · dark | light · dark |
  | `prim09-autosw-on` | light · dark | light · dark | light · dark | light · dark |

- **Construction.** `.autosw` `A:8375` (built at `U:8438`), knob `A:8378`, on `A:8380`/`A:8382`, hover `A:8384`, focus `A:8385`, disabled `A:8386`. Dead canon `.switch` `P:330` then `F:203-230` (34×20 pill).
- **Usages.**
  - SHELL.md: DS-K16.
  - AGENCY.md: AG-C51.
  - PORTAL.md: PAS-01, PAS-02 (drawn with DS-PRIM-10 per CLIENT AC-18 and AC-19).
- **Drift.** The dead hub switch is a 34×20 pill. The live one is a 42×20 square. `.wf__toggle` `A:12626` is a disclosure, not a switch (DS-PRIM-31). PAS-01 and PAS-02 use a segmented On/Off instead of a switch.
- **Defects not to copy.** The on knob is a `--success` **fill**, which breaks the rule that status is an outline, never a fill. Ruled by DR-27: the build draws an ink knob with a `--success` border and no fill.

## DS-PRIM-10 Segmented control and facet

- **Purpose.** Pick one of two to five options that switch a view or filter in place.
- **Anatomy.** `.segmented`: a bordered group of buttons with 1px dividers; the pressed one is filled. `.facet`: a separate bordered button per option with an optional count (DS-PRIM-13 inline) and optional status line (DS-PRIM-14).
- **Variants kept.**
  - `.segmented` on paper: Mono 12/300 upper-case, pressed = `--text` fill with `--bg` text.
  - `.segmented` on the app strip: re-skinned in app-ink (idle app-ink 60%, pressed app-ink fill with app-chrome text, border app-ink 22%). Placement is COMPOSITES.
  - `.facet`: Sans 13.12, `--bg` ground, 1px `--border`; pressed = `--accent` border and `--text` text, **no fill**.
- **States.** default, hover (**no rule** on `.segmented` or the page `.facet`: SHELL I8), focus-visible (global ring), active (no change), pressed. The board facet `.cbd__facet` does draw a hover: `--text` ink and a `--border-strong` border (`A:7114`; FA-BOARDS-59). Build that hover on every facet: a control with no hover is the recorded defect I8, and one facet should not have two dialects (lane RECONCILE-LOOK, 27 September).
- **Styling.** Segmented buttons 30 tall, padding 5.6px 11.2px, tracking +.24px; group border 1px `--border-strong`. Facet 34 tall, padding 5.6px 11.2px, gap 7.2; colour transition 120 ms `--ease`.
- **Shots.**

  | Shot folder | default | hover | focus-visible | active | pressed |
  |---|---|---|---|---|---|
  | `prim10-segmented` | light · dark | – | – | – | – |
  | `prim10-segbtn` | light · dark | light · dark | light · dark | light · dark | light · dark |
  | `prim10-facet` | light · dark | light · dark | light · dark | – | light · dark |

- **Construction.** `.segmented` `A:114`, button `A:115`, pressed `A:122`, dark fix `A:123`, app-strip re-skin `A:2735-2737`; used as `#viewSwitch` on every page and in account settings (`client-portal/account/index.html:640`). `.facet` `A:2951`, `.facet .num` `A:2953`. Dead canon `.segfield` `F:234-256`.
- **Usages.**
  - SHELL.md: DS-K5, SH-16, SH-60, SH-61.
  - AGENCY.md: AG-P3, AG-P22, AG-E3, AG-S24, AG-X21, AG-X22, AG-X23, AG-K14 (`.facet`), AG-C12, AG-S11, AG-A6.
  - BOARDS.md: P-62.
  - CLIENT.md: AC-18, AC-19.
  - DOCK.md: CR-20, CR-21 (`.facet`). NT-03 (`.cmtab`): alias, the panel tab set is DS-COMP-23.
  - TASKS.md: DP-20c, TP-12, TG-02 (`.facet`). DP-11, DP-12, DT-14, TT-04 (`.cmtabs`): alias, the panel tab set is DS-COMP-23.
  - PORTAL.md: PP-10 (`.cbd__facet`). (PB-04, PB-06 and PB-07 moved to DS-COMP-38, 27 September.)
- **Drift.**
  - Two pressed dialects: ink fill (`.segmented`, `.crm__kinds`, `.cbd__preset`) and accent outline (`.facet`, `.cbd__facet` `A:7112`, `.mtype`, `.slot`). Both kept as named pressed looks (DR-28): the fill switches a view, the outline filters a list.
  - `.cbd__facet` (B-06, PP-10) is Sans 12 with `--border`; TG-02 `.facet` is 13.12 with `--border`; CR-20 uses a pressed `.btn--secondary`. Drop to `.facet`.
  - AG-A6 draws its own legend-filter strip (charts, COMPOSITES).
- **Defects not to copy.** No hover rule; 13.12 px is off the type scale; the dark override `A:123` exists only because `--text`/`--bg` do not flip there.

## DS-PRIM-11 Chip and pill

- **Purpose.** A short label that classifies: state, kind, count, scope, a filter in force, a suggestion.
- **Anatomy.** A pill-shaped inline label, Mono upper-case; optional leading glyph; optional remove × (filter tag).
- **Variants kept.**
  - `.chip--outline` (default): 1px `--text-2` border, `--text-2` text.
  - `.chip--soft`: 1px `--border` border, `--text` text (counts such as "8 open").
  - Tone (via `.is-ok` / `.is-warn` / `.is-bad` / `.is-info`): border and text in the status colour. This is the status chip, DS-PRIM-15.
  - Filter tag (`.cbd__tag` `A:7099`): Sans 12, 1px `--accent` border, key in `--text-muted`, value in `--text`, remove × (`.cbd__tagx`). Drawn square; chips are pills everywhere (DR-29), so the build draws it as a pill. Kept as a variant.
  - Suggestion chip (`.aip__chip` `A:707`): Sans 12.48, `--border`, hover `--accent` border. Square, clickable.
  - Pill = chip. The DS `.u-pill` (`L:61`) and `.btn--pill` (`B:92`) have zero call sites; `.chip` is the pill.
- **States.** Label chips have none. Suggestion chips: hover (border `--accent`, text `--text`), focus-visible (global ring). Colour and border transition 120 ms `--ease`.
- **Styling.** 20 tall; padding 3.3px 8.25px; gap 5.5; Chivo Mono 11/11 400, tracking +0.66px, upper-case; radius `--radius-pill` (999px); ground `--surface-2` 50% over paper (light #fafafa; dark `--surface`).
- **Shots.**

  | Shot folder | default | hover | focus-visible |
  |---|---|---|---|
  | `prim11-chip-outline` | light · dark | – | – |
  | `prim11-chip-soft` | light · dark | – | – |
  | `prim11-chip-warn` | light · dark | – | – |
  | `prim11-cbd-tag` | light · dark | – | – |
  | `prim11-aip-chip` | light · dark | light · dark | light · dark |
  | `prim11-cbd-chip` | light · dark | – | – |
  | `prim11-vaultpill` | light · dark | – | – |

- **Construction.** `.chip` is defined three times: `P:288` (pill, Sans 500), `L:40` (mono), `A:54` (mono upper-case .6875rem; background overridden at `A:91`). Variants `--outline` `A:64`, `--soft` `A:63`; dead `--sm` `P:305`, `--accent` `P:306`. Builder `U:163 statusChip`.
- **Usages.**
  - SHELL.md: DS-K4, DS-K17, SH-21.
  - AGENCY.md: AG-K16, AG-P16 (`--soft`), AG-P24j, AG-A3, AG-C16, AG-C17 (`.vaultpill`), AG-C35, AG-C43, AG-C46, AG-C50, AG-C51, AG-C57.
  - BOARDS.md: B-06, B-07, B-09, B-10 (`.cbd__tag`), B-11, P-10, P-11, P-13, P-14, P-26 (`.cbd__chip`), P-31, P-43, P-44, P-45, P-50, P-64, R-01, R-10, C-03, C-04, C-05, C-13, C-14, M-01, M-02, M-04.
  - CLIENT.md: BR-03, BR-46, WK-06, WK-09, DSY-11, AC-11, AC-16.
  - DOCK.md: CR-05, CR-06, CR-21, PJ-03, NT-04, NT-07, AI-10.
  - TASKS.md: DP-28 (`--soft`), DP-31, DA-08 (`--outline`), DA-09, DT-16, DT-19 (`.msg__react`), TP-10, TP-11.
  - PORTAL.md: PH-16, PP-13, PP-14, PP-15, PLV-03, PAP-01, PT-07, PC-11.
  - WORKBENCH.md: CN-W10 (`.vaultpill`), CN-W11, SI-W01, TS-W03, TS-W05, WP-W03, CL-W03, SH-05, SH-27 (`.unwired-tag`).
- **Drift.**

  | Where | What differs | Proposal |
  |---|---|---|
  | `.cbd__chip` (P-26, C-13, C-14) | Sans 11, square, 1px `--border` | Drop to `.chip--soft` |
  | `.vaultpill` (AG-C17, CN-W10) | Mono 12 lower-case, square, 33 tall | Fold into `.chip--outline`, content kept (DR-30) |
  | DOCK chips CR-05, CR-06, NT-07 | Square (the dock draws radius 0 everywhere) | Pills, as everywhere (DR-29) |
  | `pinChip` (NT-07, DT-16) | Dotted mono border: `.msg__pin`, `.58rem` (9.28 px), 1px dotted `--border-strong`, `--text-muted` (`app.css:3038-3041`; corrected from "dashed" by lane RECONCILE-LOOK against FA-DOCK-66); DR-30 folds it into the outline chip | Fold into the outline chip, content kept (DR-30) |
  | BR-46 | Sans 12 chip | Drop |
  | BR-04 to BR-06 | `.marker` (Mono 14) used as a chip beside a real chip (Mono 11) | Drop to `.chip` |
  | Clearance chip drawn twice: AG-K16 (`--outline`) and P-31 (currentColor border, `--text-2`, document glyph) | Two looks for one fact | One `.chip--outline` with the glyph |
  | B-11, M-01 scope chip | Looks like a filter tag without the × (BOARDS Q-07) | Style apart as `--soft` |
  | `.u-pill` `L:61`, `.btn--pill` `B:92`, `.sync-pill` `P:573`, `.pillmenu` `P:520`, `.tabs--pill` `P:138`, `.filter-pill` (filterable-list.css:43) | Dead pill vocabularies | Drop |

- **Defects not to copy.** `.msg__react` (DT-19) has no handler and no cursor but a title that invites a click (TASKS D-04). Decided (TICKET-PLAN R56): display only, with no pointer and no instruction in its title, or drawn unavailable (`TASK-PAGE.md` DT-19; `PLACEHOLDERS.md`, DS-PRIM-11). `A:54` silently undoes `P:288`; the comment at `P:302` ("chip--sm live at 3 call sites") is stale.

## DS-PRIM-12 Badge

**Folded by DR-31** (applied at build-ready, 27 September 2026): the kind badge is DS-PRIM-25 variant `kind badge` and the numeral is DS-PRIM-13 variant `numeral`. This entry stays as those two variants' spec; cite DS-PRIM-25 or DS-PRIM-13.

- **Purpose.** A small fixed label that marks an object's kind (an AI item, a numbered annotation).
- **Anatomy.** Two live forms: a kind label (`.ai__badge`: a rotated-square glyph plus Mono upper-case text in `--accent`) and a numbered square (`.annotation__n`: an ink square with a paper numeral).
- **Variants kept.** Kind badge; numeral badge.
- **States.** None.
- **Styling.** Kind badge: 19 tall, gap 7.2, Chivo Mono 12/300 +.24 upper-case, `--accent`, no ground. Numeral: 17×17, Chivo Mono 10, `--bg` on `--text` (flips in dark), radius 0.
- **Shots.**

  | Shot folder | default |
  |---|---|
  | `prim12-ai-badge` | light · dark |
  | `prim12-annotation` | light · dark |

- **Construction.** `.ai__badge` `A:462`; `.annotation__n` `A:432` (dark fix `A:436`). Dead canon `.badge` `P:226` + `L:31`, tones `P:241-249`.
- **Usages.**
  - SHELL.md: DS-K16 (`.badge`).
  - AGENCY.md: AG-K10.
  - CLIENT.md: BR-30 (the MOCK `unwired-tag`, not to port), MO-07.
  - DOCK.md: CL-11.
  - TASKS.md: DP-11, DP-12, DT-14, TP-12 (these are counts: see DS-PRIM-13).
  - PORTAL.md: PP-14 (`.rglyph`), PLV-03, PLK-03, PLK-04 (type glyph box).
  - WORKBENCH.md: SH-16 (diamond badge).
- **Drift.** `.cbadge` is named "badge" but is a count (DS-PRIM-13). PLK-03 and PLK-04 type-glyph boxes are icons (DS-PRIM-17). Ruled (DR-31): the badge folds into DS-PRIM-25 marker (kind badge) and DS-PRIM-13 count (numeral).
- **Defects not to copy.** `.annotation__n` needs a dark override because it paints with `--text`.

## DS-PRIM-13 Count

- **Purpose.** A number of things waiting (unread, comments, items in a filter).
- **Anatomy.** A small accent square with a mono numeral; optionally pinned to the top-right corner of its host.
- **Variants kept.**
  - `.cbadge` (default): inline.
  - `.cbadge--corner`: pinned to a host button's corner.
  - `.cbadge--plain`: numeral only, no ground (table cells).
  - `numeral` (from DS-PRIM-12, DR-31): the numbered annotation square `.annotation__n`, 17×17, Chivo Mono 10, `--bg` on `--text`; styling and shots in DS-PRIM-12.
  - Inline count (`.facet .num`, tab counts): Mono 12 `--text-muted`, no ground.
- **States.** None of its own; the corner count takes an ink ground when its host is hovered or focused (`A:9194-9195`).
- **Styling.** 16×16 (17 wide with two digits); padding 0 2.4px; Chivo Mono 10/10 400 (500 inline); text `--accent-ink`; ground `--accent`; radius 0.
- **Shots.**

  | Shot folder | default |
  |---|---|
  | `prim13-cbadge` | light · dark |
  | `prim13-cbadge-corner` | light · dark |
  | `prim13-dock-n` | light · dark |
  | `prim13-facet-num` | light · dark |

- **Construction.** `.cbadge` `A:9162` (appended again `A:10070`), `--corner` `A:9171`, `--plain` `A:10080`; builder `U:480 countBadge` (20 call sites). Copies: `.tmc__u, .dock__n` `A:6423`, `.cl__n` `A:6484`; the comments at `A:6486` and `A:7959` admit the three boxes are one dialect awaiting collapse (WIRING §47). Inline: `.facet .num` `A:2953`, `.wtab__n` `A:7330`, `.stg__n` `A:7286`, `.alerts__n` `A:7803`, `.arow__n` `A:1088`, `.cl__count` `A:6464`, `.act__count` `A:6179`, `.dcs__count` `A:7464`. Dead canon `.count` `P:252` + `L:48`, `.count--alert` `P:267`.
- **Usages.**
  - SHELL.md: DS-K16, SH-26 (`.dock__n`).
  - AGENCY.md: AG-K14, AG-P16, AG-P22, AG-P24j, AG-C12, AG-C34, AG-S11, AG-A6.
  - BOARDS.md: B-04 (`--corner`), B-07, P-10, P-36, P-62, R-01, C-03, C-04, C-11, C-24, C-42, S-05.
  - CLIENT.md: BR-07.
  - DOCK.md: DK-05, CL-06, CL-11, CR-08 (`.cl__n`), DC-13, DC-15, PJ-04, PJ-09, TM-03, NT-01, NT-02, NT-03, NT-04.
  - TASKS.md: DP-11, DP-12, DT-01, DT-08, DT-14, TP-12.
  - PORTAL.md: PH-16, PLV-02, PLV-04, PLK-05.
  - WORKBENCH.md: SH-15 ("n of N").
- **Drift.** The DS says counts are pills (DS-R). Every live count is square. Square is canonical (DR-32; the radius-0 house); the DS pill is dropped. Three hand-rolled copies of the box with different corner offsets (−3px against −.35rem). Drop the copies; build all through `countBadge`.
- **Defects not to copy.** DOCK D-18: the TM-03 count is not painted until the panel has been opened once. `.dock__n` is not built by `countBadge`.

## DS-PRIM-14 Dot and status line

- **Purpose.** The smallest status carrier, beside a label.
- **Anatomy.** A 2px wide, 11 tall vertical rule in the status colour (`.sline`), before the label. The mockup's "ANTI-DOT" rule (`A:2546`) retired the round dot in favour of this line.
- **Variants kept.** `.sline` (default); `.sline` in task priority at 3px (`A:5141`, drift); the timeline node `.nr__dot` (a square outline on a vertical line, `--watch` and `--bad` tones) as a timeline variant.
- **States.** None.
- **Styling.** 2×11; fill `--success` / `--warning` / `--danger` / `--info` / `--text-muted`; radius 0.
- **Shots.**

  | Shot folder | default |
  |---|---|
  | `prim14-sline` | light · dark |
  | `prim14-nr-dot` | light · dark |

- **Construction.** `.sline` `A:2558` after the ANTI-DOT rule `A:2546`; `.nr__dot` `A:9063`, tones `A:9074`. `U:158 statusDot` emits an inline-styled span with **no** `.sline`. Dead canon `.dot` `P:270`, tones `P:277-281`, pulse `P:285`.
- **Usages.**
  - SHELL.md: DS-K16.
  - AGENCY.md: AG-P24a, AG-C15, AG-C42, AG-S12, AG-K19 (`.sline`).
  - CLIENT.md: MO-09 (a typed ●).
  - TASKS.md: DA-09 (run dots).
  - WORKBENCH.md: CN-W02.
- **Drift.** Round dots survive in `.viewer__timeline i` `A:11260` and `.viewer__bar i` `A:11272`; the square bullet `.u-tag::before` (`assets/hub-ds/base.css:78`) is a marker, not a status. MO-09 types a ● character. Drop them for `.sline`.
- **Defects not to copy.** `statusDot` renders an empty span, so with no label it draws nothing (CN-W02; call sites `agency/connections-and-signal/index.html:379`, portfolio `:394`, `assets/connections.js:625`).

## DS-PRIM-15 Status mark (text and chip)

- **Purpose.** Say an object's state in words, in the status colour.
- **Anatomy.** The state word in the tone colour: bare text (`.spill` without `.chip`), or the same word in a tone-outlined chip (DS-PRIM-11 with `.is-*` or `.spill[data-tone]`). Status is colour on text or outline, never a fill.
- **Variants kept.** Chip (default; `statusPill`, `statusChip`); text (`.spill` bare, `.conn__status`); line plus word (DS-PRIM-14 then text; PJ-10, PJ-11).
- **Tones.**
  - `.is-*` vocabulary (`A:101-105`): ok = `--success`, warn = `--warning`, bad = `--danger`, info = `--info`, idle = `--text-muted`. Words: Healthy, Watch, Action, Info, Idle (`U:158-163`).
  - `.spill[data-tone]` vocabulary (`A:8723-8727`): wait = muted, run = `--info`, gate = `--warning`, done = `--success`, bad = `--danger`, mapped from the status word (`U:360-375`).
- **States.** None.
- **Styling.** Chip as DS-PRIM-11 with border and text in the tone (light `--success` #10b981, `--warning` #f59e0b, `--danger` #e84a5f, `--info` #009dea; dark #34d399, #fbbf24, #f87171, #38b6f1). Text form: Sans 14 in the tone.
- **Shots.**

  | Shot folder | default |
  |---|---|
  | `prim15-chip-status` | light · dark |
  | `prim15-spill-bare` | light · dark |
  | `prim15-conn-status` | light · dark |
  | `prim11-chip-warn` | light · dark |

- **Construction.** `U:158 statusDot`, `U:163 statusChip`, `U:375 statusPill` (emits `chip chip--outline spill`); `.spill` tones `A:8723-8727`; `.is-*` `A:101-105`; `U:925 verdictClass`; `PROJECT_TONE` `U:4052`. `.spill` without `.chip` at `assets/taskpage.js:123`, `assets/taskrun.js:133/181/269/319`, `assets/taskgraph.js:388`.
- **Usages.**
  - SHELL.md: DS-K13.
  - AGENCY.md: AG-K5, AG-K18, AG-K19, AG-P17, AG-P18, AG-P20, AG-P24a, AG-P24d, AG-P24e, AG-P24g, AG-P24h, AG-P26, AG-E12, AG-E16, AG-E22, AG-E25, AG-E27, AG-E28, AG-E31, AG-C12, AG-C15, AG-C20, AG-C22, AG-C25, AG-C28, AG-C31, AG-C34, AG-C39, AG-C42, AG-C51, AG-C57, AG-C60, AG-C61, AG-S12, AG-S13, AG-S14, AG-S15, AG-S16, AG-S18, AG-S21, AG-S22, AG-S25, AG-S27, AG-S28, AG-A6, AG-A7, AG-A10.
  - BOARDS.md: P-13, P-25, P-46, C-15, C-31, R-05, V-01, V-02.
  - CLIENT.md: BR-03, BR-08, BR-30, BR-37, BR-39, BR-52, RC-02, RC-06, RC-08, WK-04, WK-05, WK-09, WK-11, WK-15, WK-20, MO-06, MO-08, MO-09, TR-07, VO-02, VO-08, AC-03, AC-04, AC-07, AC-13, AC-14.
  - DOCK.md: PJ-10, PJ-11, NT-06.
  - TASKS.md: TP-04, DA-02, DA-04, DA-05, DA-07, DT-19, TA-01, TG-05, TG-06.
  - PORTAL.md: PH-13, PH-15, PH-16, PH-17, PT-07, PP-13, PP-14, PP-15, PLV-03, PAC-03, PW-01.
  - WORKBENCH.md: SH-11, SH-12, SH-17, SH-34, CN-W02, CN-W04, CN-W05, CN-W09, FM-W03 to FM-W06, SI-W01, SI-W07, TS-W03 to TS-W05, LR-W03, CL-W03, CL-W04, GA-W05, MA-W03, FN-W02 to FN-W04, RV-W04, RV-W05, WP-W03.
- **Drift.** Two tone vocabularies for one idea (`is-ok` against `data-tone=run`); two `.spill` renderings (chip from `statusPill`, bare text from the task files). Ruled (DR-33): one tone set (ok, run, gate, warn, bad, idle) and the chip as default; the bare text stays a named variant for dense task rows. Left-rule tone accents (DA-02, TA-01, TG-05 at 3px; NT-06 at 2px) belong to DS-PRIM-22 or COMPOSITES.
- **Defects not to copy.** TP-04 prints Complete in the run tone (`assets/taskpage.js:113`, TASKS D-06). The DA-05 PAUSED spill stretches to full width (TASKS D-20). PP-14 wraps inconsistently (PORTAL PO-I11). GA-W03 paints "$0" in `--success` (WORKBENCH D18). Two verdict vocabularies (MO-09, TR-07; CLIENT I7). Status colours set as small text on white fail contrast (success 2.54:1, warning 2.15:1 at 12 px; TOKENS DS-TOK-21 to DS-TOK-24, DR-65). (Added by the Astra cross-check.)

## DS-PRIM-16 Avatar and avatar stack

- **Purpose.** Show who: a person (round) or a client (square).
- **Anatomy.** A photo (`.av__img`) or initials in Mono; people round, clients square; a stack overlaps by .18rem.
- **Variants kept.**
  - Person, 22 (`--av-person` 1.35rem): `.sb__av`, `.msg__avatar`, `.sel__av`, `.viewers__p`, `.tl__av`, `.cbd__av--p`.
  - Person, large 36 (`.tmc__av`, team card): 1px `--accent` border when on, dashed when away.
  - Client, square 26 (`.cbd__av`): initials Mono 10 600 in `--text-2`, 1px `--border-strong`.
  - Stack (`.viewers`): overlapping 22 circles; the current viewer ringed in `--accent` (`is-here`).
  - People round, clients square: confirmed by DR-34.
- **States.** None, except the team card's on and away.
- **Styling.** Person 22: radius 50%, ground ink 12% mix, Mono 9 initials. Team 36: `--surface-2` ground, `--accent` border. Client 26: `--bg` ground, radius 0.
- **Shots.**

  | Shot folder | default |
  |---|---|
  | `prim16-msg-av` | light · dark |
  | `prim16-tmc-av` | light · dark |
  | `prim16-cbd-av` | light · dark |
  | `prim16-viewers` | light · dark |

- **Construction.** Builder `U:4631 avFill` (image or initials), wrapped by `U:4640 sbAv` into `.sb__av` `A:5205` (`--sm` `A:5211`); size token `--av-person` `A:7613`; circles `A:7616-7627`; `.tmc__av` `A:6406`; `.person__photo` `A:2079` (3rem); `.cbd__presetav` `A:10933` (1.05rem); squares `.cl__av` `A:6478` (1.4rem), `.crm__av` `A:6652` (2.4rem), `.cbd__av` `A:7200` (1.6rem); stack `.viewers__p` `A:2506` (built at `assets/portal.js:570-579`).
- **Usages.**
  - SHELL.md: SH-13, SH-15.
  - BOARDS.md: P-11, P-24, P-37, P-42, R-10, C-20.
  - CLIENT.md: BR-01, VO-04, AC-11.
  - DOCK.md: CL-07, CR-01, PJ-07, TM-01, TM-04.
  - TASKS.md: DP-18, DT-03, DT-12, DT-16.
  - PORTAL.md: PH-04, PP-18, PLV-05, PC-11.
- **Drift.** Sizes 16, 22, 22.4, 26, 36, 38.4, 48 px and three grounds (ink 12% mix, `--surface-2`, `--surface`/`--bg`). SH-13 draws a person's initial in a square (off the rule). PJ-07 draws unassigned as a dashed "A". Proposal: three sizes (22, 36, 48) and one ground per kind.
- **Defects not to copy.** `A:7613-7620` patch earlier widths by source order. `.viewers__p` builds initials without `avFill`.

## DS-PRIM-17 Icon and door mark

- **Purpose.** Glyphs for actions and objects; the door mark says where a link goes.
- **Anatomy.** Flaticon UIcons regular-rounded as a font (`fi fi-rr-*`), inheriting `currentColor`. **Build (TICKET-PLAN R52, #331):** the build swaps to an open-licence icon set (MIT, ISC or Apache, for example Lucide, Tabler or Phosphor) drawn to match this regular rounded style. The `fi-rr-*` names in this catalogue identify the glyph to match, not the asset to ship. The door mark is a trailing glyph at .85em in `currentColor` 62% (`arrow` for another page, `external` for a new tab, a panel's own glyph for a dock panel, `sparkle` for "the agent asks").
- **Variants kept.** Icon (default); door mark.
- **States.** Inherit from the host (door marks follow host hover and focus: DS-F4).
- **Styling.** Sizes seen: 16 (dock tabs, collapsed rail), 13 (search), 12.8 (appbar nav), 11.2 (timer), 8.32 (rail fold); colour `--text-muted` idle. No size scale exists.
- **Shots.**

  | Shot folder | default | hover | focus-visible |
  |---|---|---|---|
  | `prim17-dock-icon` | light · dark | – | – |
  | `prim17-door` | light · dark | light · dark | light · dark |

- **Construction.** Font import `T:37` (232 uses); no base `.fi` size rule. `U:1032 DOOR_MARKS`, `U:1047 doorMark`, `U:1077 doorAttrs`, `U:1114 doorKind`; `.door__mark` `A:11827`, hidden in `[data-unwired]` `A:11860` and print `A:11866`, host overrides `A:12051-12052`. `U:1146 taskIcon`, `U:1372 srcIcon`.
- **Usages.**
  - SHELL.md: DS-I1 to DS-I3, DS-I5, SH-7, SH-9, SH-11, SH-12, SH-14, SH-17, SH-25, SH-30.
  - AGENCY.md: AG-K1, AG-K7, AG-K8, AG-E12, AG-E16, AG-C15 (favicons), AG-C57 (typed glyphs), AG-S1, AG-A6 (typed glyphs).
  - BOARDS.md: B-01, B-04, B-12, B-13, B-15, P-10, P-13, P-20 to P-28, P-33, P-43, P-49, C-03, C-04, C-10 to C-17, C-23, C-24, C-42, S-05.
  - CLIENT.md: BR-02, BR-16, BR-20, BR-35, BR-44, BR-47, DSY-07, DSY-12, DR-02, DR-03, DR-04, VO-02, VO-08.
  - DOCK.md: DK-02, DK-08, DK-09, CL-08 to CL-11, CR-05 to CR-10, CR-20, CR-28, AI-01, NT-06.
  - TASKS.md: DP-01, DP-14, DP-32, DA-04, DA-06, DT-04, DT-10, TP-01.
  - PORTAL.md: PP-12, PP-14, PLD-03, PLK-06, PAC-03.
  - WORKBENCH.md: SH-02 (external favicons), SH-13, SH-18, SH-25, CN-W03, SI-W02.
- **Drift.** 56 contextual `.fi` rules with 12 sizes (.7rem to .95rem, .85em, .9em). Typed glyphs instead of icons: "×" 15 times, "✓" in `.sbbox`, "→" 107 times in JS, ⑂ ▤ ▥ ›_ ◎ in AG-C57, ↗ typed as the external mark on in-app links (AG-A7, BR-50, BR-57, BR-58, PC-12). Proposal: an icon size scale of three steps (12, 14, 16) owned by TOKENS; every glyph from the font.
- **Defects not to copy.** Internal pages marked external (AG-A7 at `assets/activationmap.js:137`, PC-12). `target="_blank"` chlinks with no external mark (`U:7207-7208`).

## DS-PRIM-18 Tooltip and callout

- **Purpose.** Explain a term or name an icon without taking space.
- **Anatomy.** `.term`: the explained word with a dotted `--text-muted` underline and a help cursor; the bubble is `::after` reading `data-tip`. The callout is the same bubble dialect beside a dock tab (`.dock__tablabel`).
- **Variants kept.** `.term` (below-left, default); `.term--end` (right-anchored); `.term--down` (table headers); the callout (to the left of the dock rail; above at 900 and under). Callout placement belongs to lane SIDEBAR.
- **States.** Hidden; shown on hover and focus-visible. No dismiss or Escape.
- **Styling.** Term: Chivo Mono 12/300 upper-case in a stat label (inherits the host type), dotted 1px bottom border `--text-muted`. Bubble: `--void` ground, `--on-dark` ink, Funnel Sans .78rem, padding .5rem .7rem, max-width 260, 7px stand-off, radius 0, no motion.
- **Shots.**

  | Shot folder | default | hover | focus-visible |
  |---|---|---|---|
  | `prim18-term` | light · dark | light · dark | – |
  | `prim18-tablabel` | light · dark | light · dark | light · dark |

- **Construction.** `.term` `A:733`, bubble `A:734`, show `A:741`, `--end` `A:743`, `--down` `A:1335`, `.topbar .term` `A:1441`; builders `U:137 kpiSm` (`opts.tip`) and `U:239 tableInner` (`col.tip`). Callout `.dock__tablabel` `A:4996`, show `A:5005-5008`, 900 flip `A:5011`, `.dock--tipflip` `A:5020`, sheet tabs `A:6013`.
- **Usages.**
  - SHELL.md: DS-K10, DS-K11, SH-9, SH-15 (native title), SH-25.
  - AGENCY.md: AG-K9, AG-P17, AG-P24d (`--down`), AG-P24i, AG-E30, AG-C35, AG-C57, AG-S13.
  - BOARDS.md (native title): B-04, B-06, B-12, B-15, P-13, P-20, P-22, P-27, P-30, P-36, C-04, C-11, S-05.
  - CLIENT.md: WK-04, WK-06, BR-21, DSY-12.
  - DOCK.md: DK-03 (callout), CL-02, PJ-07, PJ-09.
  - TASKS.md: DP-12, DP-14, DP-15, DP-29, DT-19, TG-05 (`data-tg-note`).
  - WORKBENCH.md: SH-19, SH-20, SH-21, CN-W04, CN-W06, CN-W08, FM-W03, FM-W06, FM-M10 to FM-M13, GA-W03, GA-M08 to GA-M10, EM-W03, EM-M10, EM-M11.
- **Drift.** 151 native `title=` tooltips, unstyled (boards, SH-15, `button.fresh` at `U:885`). `.oncal__pop` `A:6332` is a dark hover card with an arrow (a third dialect; DS-PRIM-19). The hub `[data-tip]` tooltip (`P:619-643`) has an arrow, a `--text` 88% ground, centred placement and a fade. Proposal: `.term` for explained words, the native title only for icon names, drop `[data-tip]`.
- **Defects not to copy.**
  - `.term` carries `data-tip`, so the hub `[data-tip]` rules also apply: on hover the bubble takes `translateX(-50%)` and shifts half its width left, and a second arrow draws at 50% (`P:620`, `P:642-643`). The `hover` shot shows the shifted bubble.
  - Inside an unwired tile the bubble inherits the tile's .55 opacity and reads grey on light (shot `prim18-term`, hover light).
  - DK-03 has no edge in dark (DOCK D-12). SH-9 sets a title only when an icon was injected.

## DS-PRIM-19 Menu and popover

- **Purpose.** A list of options or a small panel opened from a control, over the page.
- **Anatomy.** A bordered box under its trigger; option rows; the chosen row ticked. The popover form carries a header, fields and actions (filter menu, date picker).
- **Variants kept.**
  - Option menu `.sel__menu` (default): 1px `--accent` border, `--bg` ground, shadow, options Sans 13.6 in `--text-2`; hover row; `is-on` row in `--accent` with a ✓.
  - Filter popover `.cbd__menu`: 352 wide, padding 12, gap 12, 1px `--border-strong` border, right-anchored, 4px below the trigger.
  - Date picker `.dp__pop`: accent border, padded grid. The calendar grid is handed to COMPOSITES.
- **States.** Closed, open; option hover and `is-on`. No keyboard highlight (no active-descendant style) and no focus-visible on options.
- **Styling.** Border 1px (`--accent` or `--border-strong`); ground `--bg` (dark: the void); shadow black 45% (dark and light, from `--shadow-overlay` style values); radius 0; no motion.
- **Shots.**

  | Shot folder | default |
  |---|---|
  | `prim19-sel-menu` | light · dark |
  | `prim19-cbd-menu` | light · dark |

- **Construction.** `.sel__menu` `A:1956`, `.sel__opt` `A:1962-1965`, geometry overridden at `A:2231`, `A:11552`, `A:11558-11559`, `A:5442`; reused by `U:4327 sbTagMenuHtml` (`.tgs__menu` `A:11175`) and `assets/board.js:165` (`.cbdta__menu` `A:11292`). `.cbd__menu` `A:11661` (`assets/board.js:817`). `.dp__pop` `A:2399` (`assets/portal.js:948`), reused by `.bk__slotpop` `A:3347`. Dead canon `.menu` / `.menu__item` / `.menu__sep` `P:447-476`.
- **Usages.**
  - AGENCY.md: AG-K17.
  - BOARDS.md: B-03, B-05, P-33 (`.cbd__routes--pop`), P-37.
  - CLIENT.md: BR-17 (`.bkpop`), BR-19, BR-21, VO-06.
  - DOCK.md: AI-02, DC-09, DC-10.
  - TASKS.md: DP-18, DP-20, DP-20a to DP-20d, DP-27.
  - PORTAL.md: PC-05, PLV-08.
  - WORKBENCH.md: SI-M11, SI-M13, SI-M14, SIR-M12, SIR-M14, SIR-M15.
- **Drift.** `.bkpop` `A:7725` is an inline block with no shadow; `.oncal__pop` `A:6332` is a dark hover card with a hard-coded rgba shadow; `.cbd__routes--pop` `A:10990` is a hover-revealed action tray. Two border colours for the same box. Ruled (DR-4): one menu box with the `--accent` border as measured on `.sel__menu`; `.bkpop` is this menu's in-flow placement, not drift.
- **Defects not to copy.** ArrowDown commits instead of moving; Escape bubbles (TASKS D-32). The date picker has no arrow-key movement and counts from the real clock (DP-20b, DP-20c; TASKS D-34). `.dp__btn` has no focus-visible rule. The chosen day carries `aria-current="date"` whether or not it is today, and each day button's name is only its number (`assets/portal.js:975-982`); see DS-COMP-38. (Added by the Astra cross-check.)

## DS-PRIM-20 Table and cells

- **Purpose.** Rows of like records with comparable columns.
- **Anatomy.** `.tablewrap` (horizontal scroll) > `table.table`: head cells in the marker voice, body cells, optional numeric (`.r`, tabular) and centred (`.c`) columns, a name cell with a sub-line (`.table__name`, `.table__sub`), optional sortable heads with an arrow, optional `tfoot`.
- **Shared export (C15, CS-9.10).** Any table that offers Export carries the one export control in its head slot (a DS-PRIM-1 secondary sm button, "Export CSV"); it downloads the rows as CSV, as filtered and sorted on screen and for the page's period, and writes `export downloaded (table, filters, period, row count)` · audited (SP-18). One control and one capability on this component; no table builds its own export (the mockup's seven per-table export buttons all point here: `AC-05`, `AC-09`, `PAI-03`, `PAH-02`, `CL-W03`/`CL-M10`, `EM-W04`/`EM-M12`, `AG-P27`, plus `GA-W05` and `AG-E31`).
- **Variants kept.** Default; `--dense`; sortable heads.
- **States.** Row hover `--surface-2` (120 ms `--ease`); sortable head hover (text `--text`, underline `--text`), sorted (`aria-sort`: text `--text`, arrow `--accent`), focus-visible (global ring, but heads are not focusable: see defects).
- **Styling.**
  - Head cell: Chivo Mono 12/18.6 300, +.24 tracking, upper-case, `--text-muted` (dark on-dark 55%), padding 8.8px 16px, bottom rule 1px.
  - Body cell: padding .65rem 16px, bottom rule 1px `--border`.
  - Table min-width 44rem at 640 and under, so it scrolls sideways in `.tablewrap`.
- **Shots.**

  | Shot folder | default | default @900 | hover | focus-visible | sorted |
  |---|---|---|---|---|---|
  | `prim20-table` | light · dark | – | – | – | – |
  | `prim20-table-narrow` | – | light · dark | – | – | – |
  | `prim20-th` | light · dark | – | light · dark | light · dark | light · dark |
  | `prim20-row` | light · dark | – | light · dark | – | – |
  | `prim20-conn` | light · dark | – | – | – | – |
  | `prim20-cbd-head` | light · dark | – | – | – | – |
  | `prim20-cbd-row` | light · dark | – | light · dark | – | – |

- **Construction.** `.tablewrap` `A:337`; `.table` `A:339-357` (`--dense` `A:352`, `.r`/`.c` `A:350-351`, `__name`/`__sub` `A:353-354`, `tfoot` `A:355`); sort `A:1446-1450`; narrow min-width `A:1718-1722`; builders `U:232 tableInner`, `U:253 table`. Under it the hub `.table` `P:604-614` (600 weight heads, `--text-2` cells) still leaks its cell colour.
- **Usages.**
  - SHELL.md: DS-K7.
  - AGENCY.md: AG-K12, AG-P24 (a to k), AG-C14, AG-C15, AG-C16 (`table.conn`), AG-E22, AG-E25, AG-E31, AG-S12, AG-S17, AG-S19.
  - BOARDS.md: B-15 to B-21, P-20 to P-28, P-64, C-10 to C-17, C-25, C-31, C-32 (board tables: handed to COMPOSITES for the board row; cells cite this).
  - CLIENT.md: BR-57, MO-06, MO-08, AC-04, AC-07.
  - DOCK.md: PJ-05 to PJ-11 (a CSS grid, not `.table`), CR-28 (grid rows).
  - PORTAL.md: PM-04, PAI-04, PH-11 (`.mmeta__row`), PC-10 (`.detail__row`).
  - WORKBENCH.md: SH-20, CN-W02 to CN-W08, CN-M07 to CN-M21, CNX-M12 to CNX-M26, TL-W04, TL-M10, OB-W04, OB-M09, FM-W03, FM-W06, FM-W09, FM-M14, SS-W06, SS-W08, SS-M11, SS3-M11, SI-W07, SI-W09, SI-M18, SIR-M19, GA-W05, LR-W06, LR-M09, CL-W03, CL-M11, EM-W04, EM-M13, FN-W04, FN-M10, RV-W04, RV-M09.
- **Drift.**
  - `table.conn` (`A:2913-2940`, `A:4265-4395`; AG-C14, AG-S12): heads Mono 12/400 with 24 padding, its own row hover and `aria-expanded`, sort arrows in `--border`.
  - `.cbd__tbl` (`A:7140-7166`; B-15, C-31, P-64): heads with no padding and a `--border-strong` rule, cells .5rem, auto layout in C-31 and P-64. Handed to COMPOSITES as the board table.
  - CN-M07 heads 12/400 `--text`, padding 8.8px 24px; SS-M11 a head with no label.
  - Grid "tables": `.act__row` `A:6188`, `.tl__row` `A:5127`/`A:9356`, `.cl__row` `A:6466`, `.grad__row` `A:8336`, `.chan__row` `A:8470`, `.exc__row` `A:8758`, `.detail__row` `A:3068`.
  - Two sort-indicator dialects (AG-K12 ⇅/▲▼; B-16 an accent arrow on the head rule; AG-C14 lifts the head onto paper).
  - Proposal: one `.table` with `--dense`, one head voice (300 weight, 16 padding), one sort arrow.
- **Defects not to copy.** Row hover on non-interactive tables suggests a click that does nothing. Sortable heads have no `tabindex`, and B-15 heads are spans; B-17 resize grips respond to the mouse only (BOARDS D-05). CR-28 openable rows are divs with no keyboard access (DOCK D-13).

## DS-PRIM-21 Card (base)

- **Purpose.** A bordered group for one topic on a page.
- **Anatomy.** `.card` (flex column): optional `.card__head` (title and actions), `.card__title`, `.card__sub`, body; `.card--flush` drops the padding so a table can run edge to edge; `.card__pad` restores it for a part.
- **Variants kept.** Default; `--flush`; `--interactive` (the whole card is a link: hover sets the border `--accent-ring`; the drawn 1px lift and shadow are not built, DR-2).
- **States.** Default; hover (only `--interactive`); focus-visible (global ring on `a.card`); border-colour transition 220 ms `--ease`.
- **Styling.** Padding 24 (`--s-5`); gap 16; ground `--surface` (light = paper #fff, dark on-dark 3% over the void); border 1px `--border`; radius 0; shadow `--shadow-sm` (light rgba(15,18,24,.05), dark black 45%). Title Funnel Sans 15/18 600; sub Sans 13 `--text-muted`.
- **Shots.**

  | Shot folder | default | hover | focus-visible |
  |---|---|---|---|
  | `prim21-card-plain` | light · dark | light · dark | light · dark |
  | `prim21-card` | light · dark | light · dark | light · dark |
  | `prim21-card-interactive` | light · dark | light · dark | light · dark |

- **Construction.** `.card` `A:234-244` (`--flush` `A:240`, `__head` `A:241`, `__title` `A:242`, `__sub` `A:243`, `__pad` `A:244`), `__head--wrap` `A:3580`, `position:relative` `A:968`, transition `A:2258`. Hub `.card` `P:152` (radius and `--shadow-sm`, which still apply), `.card--interactive:hover` `P:163-167`. No builder.
- **Usages.**
  - SHELL.md: DS-K8, SH-43, SH-44, SH-55 (`a.vcard`), SH-56.
  - AGENCY.md: AG-K10, AG-P12, AG-P16, AG-P18, AG-P19, AG-E7, AG-E22, AG-E23, AG-E25, AG-E27, AG-E28, AG-E32, AG-E33, AG-C22, AG-C25, AG-C27, AG-C28, AG-C29, AG-C31, AG-C34, AG-C42, AG-C43, AG-C51, AG-C53, AG-C57, AG-C60, AG-C61, AG-S15, AG-S17, AG-S19, AG-S22, AG-S24 to AG-S28, AG-X20.
  - BOARDS.md: B-24, R-02, R-04, C-41, S-03, G-05, P-48, V-01, V-02.
  - CLIENT.md: BR-13, BR-33, BR-44, BR-50, RC-01, WK-15, WK-23, MO-06, MO-07, TR-07, TR-08 (`--interactive`), BD-02 to BD-06, VO-02, DR-02, DR-03, DR-04, DOC-01 to DOC-04, AC-03, AC-08, AC-10, AC-11, AC-13, AC-14, AC-16, AC-17.
  - DOCK.md: CR-07 to CR-10, CR-23.
  - TASKS.md: DA-02, DA-05, DA-07, TA-01, TA-04, TA-05, TA-08, TA-11, TP-07.
  - PORTAL.md: PH-07, PH-15 to PH-18, PT-08, PP-13, PP-14, PP-15, PG-04, PLB-04 to PLB-08, PLD-03, PLV-03, PLK-03, PLK-04, PAP-01, PAC-03, PC-04, PC-12, PB-03, PB-05.
  - WORKBENCH.md: SH-16, CN-W12, OB-W05, TL-W04, TL-W05, SS-W02, SS-W03, SS-W05, SI-W02, SI-W04, GA-W01, GA-W02, MA-W03, TS-W02 to TS-W05, EM-W01, EM-W04, WP-W05.
- **Drift.**
  - Accent-left-rule cards: `.ai` (AG-K10, SH-16), `.rec` (RC-01, P-48), `.brief__ask` (BR-44), `.road__item` (G-05), `.handoff` (WK-23), DSY-11, `.ccta` (PW-02, 3px), 3px state rules (AG-A7, AG-A2), 3px inset (AC-16). Ruled (DR-35): one `--flagged` variant with a 2px `--accent` left rule for AI and recommendation cards; a 3px rule that marks a state stays 3px (DR-9).
  - `a.vcard` (SH-55): Display 20 title, min-height 260, accent rule. Drop to `--interactive`.
  - Look-alikes that are composites (handed to COMPOSITES): `.alerts` `A:7793`, `.gate` `A:8454`, `.tph__stats` `A:12683`, the portal `.hero`, `.rcard`/`.tcard` (PP-13, PP-14), `.set__card`.
  - Hub `.card__header` against app `.card__head`: two names. Keep `__head`.
- **Defects not to copy.** The hub `--shadow-sm` sits under every card unintended (in dark it is black 45%). `--interactive` lifts on hover, against the "rows never move" note at `A:2255` (ruled by DR-2: no lift anywhere; hover changes the border only). `a.card` needs an inline `text-decoration:none` (SH-43) and has no focus rule. PLD-03 has no hover by ruling while PLK-03, PH-15 and PT-08 hover `--accent`.

## DS-PRIM-22 Banner and tip

- **Purpose.** A message about the section or page: a warning, a failure, or a dismissible explainer (tip).
- **Anatomy.** `.banner`: a box with a 1px `--border` outline and a **2px left rule** in the tone; body text with an optional `<strong>` lead; optional action button (DS-PRIM-1); optional dismiss × (DS-PRIM-2, 24 square).
- **Variants kept.**
  - Warning (default, `--warning` rule).
  - `--bad` (`--danger` rule): also the section error state (DS-PRIM-30).
  - `--info` (`--info` rule).
  - Tip: `--info` plus `.sectip`, one tip per section, a dismiss that is remembered, and a switch in Account that turns all tips off. Those two are capabilities to build real and tracked per person (`PLACEHOLDERS.md`, DS-PRIM-22). The mockup's browser keys (`aa-dismiss-<path>-<hash>`, `aa-tips-off`; `assets/portal.js:407-504`) are its implementation only.
- **States.** Shown, dismissed. Dismiss × hover `--text`. No motion.
- **Styling.** Padding 12px 16px; gap 16; Funnel Sans 14/21.7; border 1px `--border` with a 2px left rule; no fill; radius 0; hidden in print for `--info`.
- **Shots.**

  | Shot folder | default | hover |
  |---|---|---|
  | `prim22-banner-info` | light · dark | – |
  | `prim22-banner-bad` | light · dark | – |
  | `prim22-hint` | light · dark | – |
  | `prim22-alert` | light · dark | light · dark |

- **Construction.** `.banner` `A:598`, `--bad` `A:603`, `--info` `A:604`, `__x` `A:605` and hover `A:611`, `[hidden]` `A:7450`, print `A:618`; `.sectip` `A:2062-2066`; builders `U:190 sectionTip` and `U:178 sectionHead`; dismiss injected at `assets/portal.js:444-457`; `connprob` (`assets/connections.js:192`) reuses `.banner`.
- **Usages.**
  - SHELL.md: DS-K9, SH-27, SH-41, SH-57.
  - AGENCY.md: AG-K2, AG-K3, AG-K13 (`.hint`), AG-P5, AG-E4, AG-E26, AG-C4, AG-C6, AG-C23, AG-S4, AG-S5.
  - BOARDS.md: G-01, G-02, P-65, W-03.
  - CLIENT.md: BR-07, BR-08, BR-28, WK-03, WK-05, WK-07 (`.draftgate`), WK-19, MO-02, MO-13, TR-02, AC-15, DOC-01 to DOC-04, FM-01 to FM-04.
  - PORTAL.md: PH-02, PM-03, PT-02, PT-03, PP-04, PG-02, PLB-03, PLV-02, PLV-04, PLK-02, PLK-05, PAC-02, PC-03, PB-02, PAD-05, PW-02 (`.ccta`), PC-09 (`.chanflag`).
  - WORKBENCH.md: SH-06, SH-17, SH-23, CN-W01, OB-W01, OB-W02, OB-M07, SS-M08, SS3-M08, FN-M08, TL-W06, SS-W04, SS-W07, SS-W08, SI-W03, SI-W08, GA-W01, MA-W01, MA-W04, EM-W01.
- **Drift.**

  | Where | What differs | Proposal |
  |---|---|---|
  | `.hint` `A:534` (`U:845 hint`; AG-K13) | 1px `--text-2` rule, accent 4% wash, "AI" mark | Kept as the named `hint` variant, the agent's aside (DR-5) |
  | `.draftgate` `A:1346` (WK-07) | 3px warning rule, more padding | Drop to default |
  | `.gate` `A:8454` | 3px `--text-2` rule on `--surface` | Handed to COMPOSITES (gate block) |
  | `.chanflag` (SH-17 3px `--warning`; PC-09 3px `--accent`), `.ccta` (PW-02 3px accent), `.repedit__tag` `A:1909` (2px accent, no box) | Rule widths 1, 2, 3 px and four tones | One 2px rule, three tones |
  | G-01, G-02 | `--info` with an accent rule | Drop to `--info` |
  | Alert strip rows `.alert` (`U:1554 alertStrip`, `U:1590 alertRow`) | A list of alerts with its own row, mark, toggle and dismiss | Handed to COMPOSITES; its parts cite DS-PRIM-2, DS-PRIM-14, DS-PRIM-31 |
  | Hub `.toast` `P:371-396` | Declared, never drawn | Drop, or keep as a named gap |

- **Defects not to copy.** `banner--bad` always carries an inline `style="align-items:center"` (`agency/connections-and-signal/index.html:210`, site-health `:257`). There is no `--ok` or `--warn` modifier: warning is the unnamed default. `.alert`, `.alert__line`, `.alert__chev` and `.alert__mark` are each declared two or three times (`A:7808/8002/8574`, `A:8011/8512/8584`, `A:8526/8601`, `A:7816/8015`).

## DS-PRIM-23 Meter and progress

- **Purpose.** How much of a whole: capacity used, a score, progress to a target.
- **Anatomy.** A track with a fill whose width is derived from the number beside it (never passed in: the comment at `U:100-110`); an optional target tick (`.meter__target`, 1px, 3px past the track).
- **Variants kept.**
  - `.meter` (default): 6px square track `--surface-3`, fill `--text` (dark on-dark), tones `.is-ok`/`.is-warn`/`.is-bad`/`.is-idle`/`.is-info`.
  - Stat track (`.stat__track`, inside DS-PRIM-24): 3px, track `--border`, fill `--accent`; `is-quiet` in muted ink for finished work.
  - Time track (`.tt__bar`): 4px, track `--border`, fill `--accent`, `is-over` in `--danger` (DS-PRIM-30).
- **States.** None; display only.
- **Styling.** Heights 6, 3, 4; radius 0; no motion.
- **Shots.**

  | Shot folder | default |
  |---|---|
  | `prim23-meter` | light · dark |
  | `prim23-meter-warn` | light · dark |
  | `prim23-stat-track` | light · dark |
  | `prim23-tt-bar` | light · dark |

- **Construction.** `.meter` `A:364`, `__fill` `A:365`, dark `A:366`, tones `A:367-369`, dark tones `A:991-1004`, `__target` `A:370`; builder `U:202 meter`; `.stat__track` / `__fill` `A:313-317` (built at `U:147`); `.tt__bar` / `__fill` `A:5264-5269`; `.brn .meter` `A:8231`. Dead canon `.meter-track` / `.meter-fill` `P:313-327` (7px pill, green default).
- **Usages.**
  - SHELL.md: DS-K6.
  - AGENCY.md: AG-K5, AG-K9, AG-K11, AG-P20, AG-E22, AG-E25, AG-E27, AG-E32, AG-E33, AG-C9, AG-C15, AG-C25, AG-S22 (gauges), AG-S24 (score dial).
  - BOARDS.md: P-28 (`.brn`), V-01.
  - CLIENT.md: BR-30, BR-52, BR-57, WK-11, WK-22, AC-02.
  - TASKS.md: DT-09, DA-09, TT-03.
  - PORTAL.md: PH-15, PP-13, PP-05 to PP-08.
  - WORKBENCH.md: SH-12, SH-19, SH-22, CN-W05, FM-W04, SI-W04, SI-W05, SI-W06, TS-W04, RV-W03, EM-W01, CL-W02, CL-W04.
- **Drift.** Five heights (3, 4, 6, 7, 16) and three default fills (ink, accent, success). AC-02 is 9px with a border and its legend swatch is the wrong colour (CLIENT D5). `.drc__bar` `A:7383` 3px ink; `.pageschem__fill` `A:1365` an accent 14% wash; `.gantt__fill` declared twice (`A:8188`, `A:8649`); `.band__track` `A:821`; `.amap__nodebar` `A:12850`; `.barlist__track` `A:376` (16px, a chart: COMPOSITES). Score dials (AG-S24) and gauges (AG-S22) are charts (COMPOSITES). Proposal: two meters, 6px (standalone) and 3px (inside a stat).
- **Defects not to copy.** `meter()` emits no `role="meter"` or `aria-valuenow`. Every tone needs a dark patch (`A:991-1004`): cascade repair, not tokens.

## DS-PRIM-24 KPI number

- **Purpose.** One headline figure with its label, optional "of N", optional track and optional change.
- **Anatomy.** `.stat`: `.stat__label` (marker voice, optionally a `.term`), `.stat__num` (the figure, with `.stat__of` or `.stat__suffix`), optional `.stat__track` (DS-PRIM-23), optional `.stat__foot` with `.delta`. Tiles sit in a `.statrow` (layout: COMPOSITES).
- **Variants kept.** Default; with track; with delta. The narrow figure is 1.75rem at 640 and under.
- **States.** None; tiles are not interactive.
- **Styling.** Padding 16px 24px 16px 0; gap 8. Label Chivo Mono 12/300 +.24 upper-case, `--text-muted`. Figure Funnel Display 34/34 500, tracking −.03em, tabular (`--text-num-lg`); 28 at 640 and under. `of 14` in Mono 11 `--text-muted`.
- **Shots.**

  | Shot folder | default | default @390 | default @900 |
  |---|---|---|---|
  | `prim24-stat` | light · dark | – | – |
  | `prim24-stat-of` | light · dark | – | – |
  | `prim24-stat-narrow` | – | light · dark | light · dark |
  | `prim24-hero-stat` | light · dark | – | – |

- **Construction.** `.stat` `A:258`, `__num` `A:266` (narrow `A:677`), `__suffix` `A:271`, `__label` `A:272`, `__foot` `A:277`, `__of` `A:311`; `.delta` `A:319-328`; builder `U:124 kpiSm`. Hand-rolled `stat__num` markup at `agency/brief/index.html:675/690`, account `:489-490`, workbench `:1567/1571`. Dead canon `assets/hub-ds/stat.css:30-49`.
- **Usages.**
  - SHELL.md: DS-K14.
  - AGENCY.md: AG-K5, AG-K9, AG-P8, AG-E9, AG-E23, AG-E30, AG-C9, AG-S10.
  - CLIENT.md: BR-30, BR-37, BR-56, WK-10, TR-05, AC-01, AC-06, AC-16.
  - TASKS.md: TA-01.
  - PORTAL.md: PH-06, PH-13, PH-17, PT-04, PT-05, PP-05 to PP-08.
  - WORKBENCH.md: SH-11, SH-19, SH-23, TL-W03, OB-W03, FM-W02, SI-W05, GA-W03, MA-W01, TS-W03, LR-W02, LR-W05, CL-W02, EM-W01, EM-W03, RV-W02.
- **Drift.**

  | Where | What differs | Proposal |
  |---|---|---|
  | AG-K5, BR-30 (`--text-num-md` 26), BR-37 (Sans 24 500), PH-17 (Display 19.2), PH-06 (Display 27.2), `.tier__price` `A:1594` (1.9rem), `.hero__stat .n` `A:6152` (1.7rem), `.vrow__val` `A:792`, `.srcbox__val` `A:889`, `.bcon__num` `A:4147` | Private sizes | Two sizes: `num-lg` 34 (default) and `num-sm` 22 (compact); the hero's figures are hero-only exceptions owned by DS-COMP-31 (DR-7) |
  | WK-10 | Display 128 | Hero-only exception owned by DS-COMP-31 (DR-7) |
  | TA-01 `.tph__n` `A:12688` | Mono at `--text-h2` | Drop to the display face |
  | AC-06 | Raw `.stat` mixed with `kpiSm` | Build all through `kpiSm` |
  | PT-05, PP-05 labels `--text-muted` over a dotted `--border`; SH-19 `--text-2` over dotted `--border-strong` | Two label rules | One |
  | Portal hero stat (PH-06) | Display on the client brand | Handed to COMPOSITES (portal hero) |

- **Defects not to copy.** `.statrow` column counts carry `!important` (`A:671/676/5742/5745`). A status colour on a numeral (`stat__num is-ok`, workbench `:1571`; GA-W03). The "mock" chip `.unwired-tag` wraps short labels and breaks baselines (`U:110-123` comment).

## DS-PRIM-25 Marker, tag, stamp, index and freshness

- **Purpose.** The mono voice that labels, dates and indexes: section labels, field keys, timestamps, freshness.
- **Anatomy and variants kept.**
  - `kind badge` (from DS-PRIM-12, DR-31): the AI kind label `.ai__badge`, a rotated-square glyph plus Chivo Mono 12/300 upper-case in `--accent`, no ground; styling and shots in DS-PRIM-12.
  - `.marker`: Chivo Mono 300 upper-case. With `.u-tag` it draws a square bullet `::before` (the section label).
  - `.stamp`: a timestamp or provenance line, Mono 11 upper-case `--text-muted`.
  - `.index`: a lead key plus value, Mono 14 (`Period · 1 – 20 July 2026`).
  - Key tag (`.layer__tag`, `.clienthdr__tag`, `*__k` keys): Mono 12/300 upper-case `--text-muted`.
  - Countdown (`.ttl`, `U:390 ttlCountdown`): Mono 12 in `--warning` under an hour, "expired" as a word.
  - Freshness (`button.fresh`, `U:863 freshness`): in the mockup a bordered Mono 10.88 button with a sync glyph, "2m ago · every 5 min", with hover, focus-visible and active states. **In the product it is an indicator, never a control** (`../research/LIVE-SYNC.md`, "What the freshness marker shows", decided 27 September on the owner's words): the same bordered Mono look in its default state only, not focusable, no press, no hover or active state and no audit entry, with a quiet live mark in place of the sync glyph. It shows one of five states: Live with the data's age ("Updated 2 min ago", or a provider source's own "Data to 26 Sep, 6:10am"); Catching up ("Reconnecting · last read 10:42"); Offline ("Offline · showing data from 10:42", in `--warning`, retrying by itself); Source behind (the source's name and last good time in the status tone, linking to its row on Connections, never green over a failure); Frozen ("Frozen Saturday 6:10am", a snapshot by design). On a denied re-read the marker claims nothing.
- **States.** None interactive. The mockup's freshness button has default, hover, focus-visible and active. The product keeps only the default look, in the five indicator states above.
- **Styling.**

  | Variant | Type | Colour |
  |---|---|---|
  | `.marker.u-tag` | Mono 14/21.7 300, +.28, upper-case | `--text` |
  | Key tag | Mono 12/16.8 300, +.24, upper-case | `--text-muted` |
  | `.stamp` | Mono 11/17 400, +.22, upper-case | `--text-muted` |
  | `.index` | Mono 14/21.7 400 | `--text` key, `--text-muted` value |
  | `.ttl` | Mono 12 400 | `--warning` |
  | `button.fresh` (built as a non-interactive indicator) | Mono 10.88 300, +.22, upper-case; padding 4px 8px; 1px `--border` | `--text-muted`; Offline `--warning`; Source behind the status tone |

- **Shots.**

  | Shot folder | default | hover | focus-visible | active |
  |---|---|---|---|---|
  | `prim25-marker-tag` | light · dark | – | – | – |
  | `prim25-layer-tag` | light · dark | – | – | – |
  | `prim25-stamp` | light · dark | – | – | – |
  | `prim25-index` | light · dark | – | – | – |
  | `prim25-ttl` | light · dark | – | – | – |
  | `prim25-fresh` | light · dark | light · dark | light · dark | light · dark |

- **Construction.** `.marker` `A:26`; `.index` `A:30-34`; `.u-tag` `assets/hub-ds/base.css:77-78`; `.stamp` `A:746`; `.fresh` `A:2485`, `button.fresh` `A:2493-2498`; `.sec__meta` `A:14` hosts the marker; builders `U:178 sectionHead`, `U:863 freshness`, `U:390 ttlCountdown`; `.ttl` `A:8732`.
- **Usages.**
  - SHELL.md: DS-K12, DS-K15, SH-22, SH-43, SH-44, SH-51, SH-54.
  - AGENCY.md: AG-K1, AG-K3, AG-K15, AG-P2, AG-P23, AG-P24i, AG-E2, AG-E15, AG-E18, AG-C2, AG-C17, AG-C35, AG-C57, AG-S2, AG-S7, AG-S8, AG-A2, AG-A8.
  - BOARDS.md: P-07, P-27, P-46, P-61, P-62, R-03 (`.rglyph`), S-04, C-08, M-07.
  - CLIENT.md: BR-04, BR-05, BR-06, BR-07, BR-27, BR-34, BR-48, RC-02, RC-06, RC-08, WK-04, WK-08, WK-12, WK-16, WK-18, MO-03 (`.index`), MO-12, TR-01, DSY-01, DSY-06, AC-13.
  - DOCK.md: CL-02, CL-06, CR-10, CR-12 to CR-15, CR-25, CR-29, DC-02, DC-06, DC-17, DC-18, DC-21, BM-02, BM-07, NT-05.
  - TASKS.md: DP-14, DP-15, DP-29, DP-31, DP-32, DT-01, DT-04, DT-08, DT-22, TP-03, TP-09, TG-01, TG-03, TG-04, DA-01, DA-03, DA-10.
  - PORTAL.md: PH-01, PH-03, PH-07, PT-01, PT-03, PP-02, PW-01, PW-02, PLB-01, PLV-01, PLD-01, PLK-01, PAC-01, PC-01, PC-08, PC-10, PG-03, PB-08.
  - WORKBENCH.md: SH-03 (`button.fresh`), SH-10, SH-15, SH-16, SH-18, SH-23, SH-25, SH-26, SH-27, CN-W03, CN-W10, SI-W04, GA-W02, EM-W01, RV-W01, TS-W01.
  - Also `.ttl`: AGENCY.md AG-C and connections grant rows (inventoried under DS-PRIM-15 there).
- **Drift.** About a dozen key-tag clones at 12px (`.toprec__tag` `A:1389` 400 weight, `.ccta__tag` `A:1523` accent, `.cat__k` `A:1973`, `.cap__k` `A:1768`, `.mmeta__k` `A:2140`, `.detail__k` `A:3071`, `.panel__label` `A:2942`, `.alerts__k` `A:7798`, `.ttag__k` `A:6528`); boxed tags `.draftgate__tag` `A:1350` and `.repctl__tag` `A:3661` (bordered warning); stamp clones `.ai__stamp` `A:1884` (Sans with a dashed rule), `.cap__stamp` `A:1780`, `.lasset__stamp` `A:4081`, `.connnote__stamp` `A:4321`, `.dpanel__stamp` `A:6606`, `.alert__since` `A:8019`, `.brief__stamp` `A:1043`. Freshness has three dialects: bordered sync button (SHELL SH-22, PORTAL), `button.fresh` with a refresh icon (WORKBENCH SH-03), and a borderless stamp plus a separate icon (DOCK CL-02, CL-03). M-07 types its freshness where `/projects/` derives it. Proposal: marker (14), key (12), stamp (11), one freshness button.
- **Defects not to copy.** `.stamp` .6875rem and `.fresh` .68rem sit between tokens. The sync marker has **no handler** and no `data-unwired`, so it looks like a button that does something (SHELL D6; SH-22, AG-K1, P-07, C-08). Do not build a sync button: every page stays live by push, with a 30-second floor where push cannot reach, and the marker only reports the state (`../research/LIVE-SYNC.md`; candidate C4 in `PLACEHOLDERS.md`). This supersedes the per-page sync of WIRING §50.1 (6 August 2026) on the owner's words of 27 September: *"we don't need sync now and run checks now buttons because if we move to live"*. The hover, focus-visible and active shots are mockup evidence only.

## DS-PRIM-26 Link and door link

- **Purpose.** Go somewhere: another page, a dock panel, an outside site.
- **Anatomy.** `.chlink`: a Mono upper-case label with a 1px dotted underline; or any inline anchor followed by a door mark (DS-PRIM-17) that says where it goes. A bare `a` inherits its colour (`T:41`).
- **Variants kept.** `.chlink` (default, the labelled channel link); inline prose link (the underline takes `--accent`; `.brief__body a` `A:1052`); door link (icon-only 24 square with the arrow door mark: DS-PRIM-2 geometry).
- **States.** Default; hover and focus-visible turn text and underline `--accent` (plus the ring); the client face strips the affordance.
- **Styling.** `.chlink`: Chivo Mono 12/16.8 300, +.24, upper-case, `--text-muted`, dotted 1px bottom border `--text-muted`, hover `--accent` (#745cee). `.chlink` sets no type of its own (`A:2032-2036`: colour inherit, dotted rule at 40% of the text colour); it takes the host's Mono line, so the workbench verdict rows draw it at 14/300, +.28 (FA-WORKBENCH-16). Build it at 12 everywhere, as above; the 14 is drift.
- **Shots.**

  | Shot folder | default | hover | focus-visible |
  |---|---|---|---|
  | `prim26-chlink` | light · dark | light · dark | light · dark |
  | `prim17-door` | light · dark | light · dark | light · dark |

- **Construction.** `.chlink` `A:2032-2049`; `.door__mark` `A:11827`; builders `U:1047 doorMark`, `U:1077 doorAttrs`, `U:1114 doorKind`, `U:1409 linkSources`.
- **Usages.**
  - SHELL.md: DS-I2, DS-I3, SH-43.
  - AGENCY.md: AG-K6, AG-P24a, AG-E12, AG-E16, AG-C39, AG-C42, AG-C46, AG-A7, AG-S7.
  - BOARDS.md: P-33, P-43, P-50, L-07, C-22, R-10.
  - CLIENT.md: BR-14, BR-30, BR-39, BR-41, BR-42, BR-50, BR-55, BR-57, BR-58, WK-04, WK-16, VO-08, AC-07, AC-11, AC-12, AC-15.
  - DOCK.md: CR-05, CR-23, CR-29, DC-05, DC-16, BM-02, PJ-08, TM-02.
  - TASKS.md: TP-01, DP-29, DP-31, DA-08, TA-09, TM-04 (`.sb__addr`).
  - PORTAL.md: PF-08, PW-03, PH-11, PH-15, PAH-01, PAD-03, PAD-05, PAC-05, PC-09, PC-12, PLK-03, PLK-06.
  - WORKBENCH.md: SH-24, CN-M04, CNX-M04, CNX-M07, SS-M10, SS3-M10, SI-M16, SI-M17, SIR-M11, SIR-M17, SIR-M18, WP-M10, WPO-M10, and the `-M02` source link on every tab (CN, CNX, TL, OB, FM, SS, SS3, SI, SIR, GA, MA, LR, CL, EM, FN, RV, WP, WPO).
- **Drift.** About seven recipes: `.md a` `A:7540` (accent, no hover), `.loop__m a` `A:1184`, `.tl__t a` `A:5133`, `.swot__foot a` `A:6974`, `a.person__link` `A:2088`, `a.trow` `A:1751` (row wash), `a.alert__t` `A:8017` (underline on hover), `.draftgate__go` `A:2652`, `.repctl__go` `A:3667`, `.doors__go` `A:7395`, `a.cbd__go` `A:7404`. VO-08 chlink in Sans 13.1; AG-E12 cite in Mono accent; AC-07 Sans 12 underlined; OB-M02, GA-M02, MA-M02 at 14px (others 12). Proposal: `.chlink`, prose link, door link; drop the rest.
- **Defects not to copy.** `SIR-M11` uses a raw `#745cee`. Removed-tab links delete their text (WORKBENCH D10). PH-11 is live where it should be unwired (PORTAL PO-I1). No link other than `.chlink` has a focus style. CR-23 `mailto:`/`tel:` links carry no door mark, on purpose: keep.

## DS-PRIM-27 Divider and rule

- **Purpose.** Separate groups.
- **Anatomy and variants kept.**
  - Horizontal rule `hr.rule`: 1px `--border`.
  - Section rule: `.sec__meta` top border 1px `--rule` (ink), which heads a section (the section head itself is COMPOSITES).
  - Vertical divider `.cbd__div`: 1×20 `--border`, between toolbar groups.
- **States.** None.
- **Styling.** 1px; colours `--border` (light black 12%, dark on-dark 10%) or `--rule` (light black, dark on-dark 24%).
- **Shots.**

  | Shot folder | default |
  |---|---|
  | `prim27-rule` | light · dark |
  | `prim27-sec-meta` | light · dark |
  | `prim27-cbd-div` | light · dark |

- **Construction.** `.rule` `A:590`; `.sec__meta` `A:14`; `.cbd__div` `A:7123`; `.ai__div` `A:2466`; `.dpanel__div` `A:5094`; `.mtitle__bar` `A:6234` (`--border-strong`); `.statrow` dotted rule `A:294`; `.prior__row + .prior__row` `A:1299`. Dead hub `.menu__sep` `P:476`, `.sync-pill__bar` `P:593`.
- **Usages.**
  - SHELL.md: SH-25 (`.dock__raildiv`, SIDEBAR).
  - AGENCY.md: AG-E28, AG-A9.
  - BOARDS.md: B-14 (`.cbd__div`), P-12 (`.cbd__modediv`).
  - CLIENT.md: BR-13, BR-40, BR-45, BR-47.
  - DOCK.md: DK-04, DK-06, DK-10, CL-04, AI-04 (`.aip__actdiv`), CR-12 (dotted).
  - TASKS.md: TG-04.
  - PORTAL.md: PH-08 (`.mtitle` bar), PT-03.
  - WORKBENCH.md: SH-10, SH-11, SH-18.
- **Drift.** About twenty dashed or dotted 1px borders (`A:1376`, `A:1886`, `A:2943`, `A:8788` and others); four colours (`--rule`, `--border`, `--border`, `--border-strong`); P-12 full height in `--border-strong`. Proposal: `--border` for dividers, `--rule` only for the section head, dotted only for the stat row.
- **Defects not to copy.** Rules are borders scattered across about 30 components. There is no single weight or colour.

## DS-PRIM-28 Empty state

- **Purpose.** Say there is nothing here yet, why, and what to do next. The dock law: a panel never renders blank (WIRING §34.1).
- **Canonical, with named variants.** The mockup draws at least eighteen dialects (below). They reduce to one component with three variants:
  - `--block` (default): `.cbd__empty`. Centred, padding 48px 24px (`--s-7 --s-5`), Funnel Sans 14/21.7 `--text-muted`, one optional action link on its own line. For a whole board, table or page body. `assets/taskpage.js:49` already calls it the house empty state.
  - `--inline`: left-aligned Sans 13 `--text-muted`, block padding 16, max 60ch; one or two short lines (the second an invitation). For a panel, a list or a thread (`.dp__empty`, `.sbempty`, `.tl__none`, `.crm__none`, `.thread__none`, `.vnotes__none`, `.bk__none`, `.act__none`).
  - `--row`: Mono 12 `--text-muted`, no padding. For "nothing to act on" inside a row or card (`.ai__empty`, `.tokempty__say`, `.amap__empty`).
  - Plus one modifier, `--filtered`: "No matches for these filters" with a clear-filters action, where a filter emptied a list that is not empty (today only `.amap__stage.is-filter-empty`, opacity .42, and `.cbd__menuempty`).
- **States.** None.
- **Styling.** As above; none has an icon or a fill.
- **Shots.**

  | Shot folder | default |
  |---|---|
  | `prim28-cbd-empty` | light · dark |
  | `prim28-thread-none` | light · dark |
  | `prim28-ai-empty` | light · dark |

- **Construction and every dialect.**

  | Dialect | Rule | Style | Rendered at | Becomes |
  |---|---|---|---|---|
  | `.cbd__empty` | `A:7237` | centred, 48/24 padding, .875rem | `assets/board.js:1185`, `assets/projectsboard.js:224/1948`, `assets/crmboard.js:738`, `assets/taskpage.js:56` | `--block` |
  | `.dp__empty` | `A:4541` | .8125rem, lh 1.55 | `assets/dock-notes.js:186`, `assets/dock-notifications.js:648`, dock marks and team | `--inline` |
  | `.tl__none` | `A:5147` | .8125rem, 16 block padding | `assets/dock-tasks.js:407` | `--inline` |
  | `.sbempty` | `A:3802` | .82rem, no padding | sideboard in `U`, `assets/taskgraph.js`, `assets/taskpage-team.js` | `--inline` |
  | `.crm__none` | `A:6863` | .8125rem, lh 1.5 | `assets/clientrecord.js` | `--inline` |
  | `.vnotes__none` | `A:3893` | .85rem | `U:7124` | `--inline` |
  | `.thread__none` | `A:12190` | .85rem, pushed to the bottom | client-portal projects | `--inline` |
  | `.act__none` | `A:6206` | `--text-sm`, `--text-2`, max 60ch | `U:7670` | `--inline` |
  | `.bk__none` | `A:3359` | .875rem | `U:3058` | `--inline` |
  | `.ai__empty` | `A:488` | mono `--fs-mono-sm` | `U:688`, `U:797` | `--row` |
  | `.tokempty__say` | `A:9531` | `--text-overline` | token track in `U` | `--row` |
  | `.amap__empty` | `A:12863` | 12 padding, `--text-overline` | `assets/activationmap.js` | `--row` |
  | `.amap__missing` (AG-A5) | – | dashed box | `assets/activationmap.js` | `--block`; kept as drawn (decided at build-ready) |
  | `.cbd__menuempty` | `A:11688` | `--text-sm` | `assets/board.js:827` | `--filtered` |
  | `.is-filter-empty` | `A:12864` | opacity .42 | activation map | `--filtered` |
  | `.approval__meta` reused | `A:556` | mono | `assets/connections.js:331`, `U:8686` | `--row` (drop the reuse) |
  | `.muted.t-xs`, bare `<p>`, `.prior--none` marker | – | – | `U:8450`, `assets/activationmap.js:152`, `U:2182` | `--inline` |
  | Hub `.empty` | `P:724-728` | centred, icon circle, title, description | unused | drop |
  | Hub `.flist__empty` | `filterable-list.css:89` | mono upper-case, bottom rule | unused | drop |

- **Usages.**
  - SHELL.md: DS-X1.
  - AGENCY.md: AG-K10, AG-A5, AG-A6, AG-A11, AG-C16, AG-C34, AG-C35, AG-C44, AG-C53, AG-C60, AG-C61, AG-E10, AG-E13, AG-S25, AG-S28.
  - BOARDS.md: B-05, B-23, P-51, P-63, P-67, L-08, V-04.
  - CLIENT.md: BR-07, BR-20, BR-21, BR-53, RC-06, RC-07, VO-04, VO-08, DSY-11, WK-19.
  - DOCK.md: CL-12, CR-05, CR-06, CR-10, CR-12, CR-14, CR-30, CR-31, DC-12, DC-19, BM-09, PJ-12, TM-06, NT-09, NT-10.
  - TASKS.md: DP-15, DP-20, DP-27, DP-29, DP-33, DT-07, DT-15, DA-09, TA-04 to TA-10, TG-07, TG-08, TG-09, TT-01 to TT-05, TM-02, TM-03, surface S9.
  - PORTAL.md: PP-18, PW-02, PAC-01.
  - WORKBENCH.md: SH-15, SH-16, SH-23, CN-W01, CN-W06, CN-W09, CN-W10, OB-W01, MA-W01, SS-W06, WP-W03.
- **Drift beyond the dialects.** Some surfaces remove the whole section at zero (AG-E10, AG-E13, AG-C44, BR-07, WK-19) instead of saying so; OB-W01 and MA-W01 use a banner as the empty state; CR-05 and CR-06 a dashed chip; CR-12 "not recorded" in `--text-dim`; DP-27 hides with no box; CL-12 draws nothing (DOCK D-6). Ruled by DR-36: a section always shows, with an empty state at zero; none is removed.
- **Defects not to copy.** The task-not-found error renders as an empty state (`assets/taskpage.js:56`; it is an error, DS-PRIM-30). RC-07 reuses `.ai__empty` for "No response needed", which is not an empty state. DT-15 says "project" on a task surface (`U:5045`, `U:5100`; TASKS D-23).

## DS-PRIM-29 Loading state (gap, proposed)

- **Status.** The mockup is static and has **no loading pattern**: nothing in `app.css` or the JS matches skeleton, shimmer, spinner, `is-loading` or `aria-busy` (the one `aria-busy` is scraped data at `assets/data.js:1925`). The hub `.skeleton` (`P:711-719`, `--line`, `--circle`, a sweep keyframe) is unused. The only live pattern is a disabled `.btn` whose label reads "Syncing…" (`assets/connections.js:595`), followed by `.syncflash` (`A:9303`) for the outcome.
- **Adopted (DR-37).**
  1. **Busy button** (exists in part): the button keeps its size, swaps its label to the present participle ("Syncing…"), sets `disabled` and `aria-busy="true"`; no spinner.
  2. **Block skeleton**: grey bars in `--surface-2` at the height of the text they stand for, square, no shimmer under `prefers-reduced-motion` (a slow opacity pulse otherwise, `--dur-3`). For tables, lists and KPI tiles on first load.
  3. **Panel line**: a DS-PRIM-28 `--inline` line reading "Loading…" in `--text-muted` for dock panels, so a panel is never blank (WIRING §34.1).
- **Usages (where a loading state is needed or faked).** DOCK.md CL-02 (CL-03 "syncing…" is removed by live sync); WORKBENCH.md CN-W07 ("Syncing…" disabled), SS-W02 (lazy, draws nothing); SHELL.md DS-X2. Ops Astro's WEB.md already records a loading gap on the task page.
- **Shots.** None (nothing to shoot).

## DS-PRIM-30 Error state

- **Purpose.** Say something failed, where, and what to do.
- **Canonical, with variants.**
  - **Section or page error**: DS-PRIM-22 `.banner--bad` (2px `--danger` left rule, 1px `--border` box, no fill).
  - **Inline row note**: `.alert__err` (`A:8069`, `U:1667`), a `--text-2` line, deliberately not red (ruled by DR-38: the row's mark already carries the tone).
  - **Over-limit**: the tone on a meter fill (`.tt__fill.is-over` `A:5269`, `--danger`) or a date (`.tl__due.is-bad` `A:5136`).
  - **Field error (gap, adopted at build-ready)**: no form field anywhere has an error state. Adopt the dead hub rules as the proposal: `[aria-invalid]` border `--danger`, and a `.field__error` line below in Sans 12 `--danger` (`P:733-736`, `F:67-74`, `F:96`).
- **States.** None.
- **Styling.** As DS-PRIM-22 (`--danger` light #e84a5f, dark #f87171).
- **Shots.**

  | Shot folder | default |
  |---|---|
  | `prim30-banner-bad` | light · dark |
  | `prim22-banner-bad` | light · dark |

- **Construction.** `.banner--bad` `A:603`; `.is-bad` `A:103`; `.alert__err` `A:8069`; `.syncflash.is-bad` `A:9307`; `.wf__fail` `A:12646` (`assets/taskrun.js`); `.exc__row--stale` `A:8762` (3px danger left rule); `.tt__fill.is-over` `A:5269`. Dead: `.field__error` `P:735`, `.input[aria-invalid]` `P:733-734`, `.toast[data-tone=danger]` `P:388`.
- **Usages.**
  - SHELL.md: DS-X3.
  - AGENCY.md: AG-C6, AG-S4, AG-C54, AG-C61.
  - CLIENT.md: BR-12.
  - TASKS.md: DA-04 (`.wf__fail`), DA-09, DT-09 (over estimate).
  - PORTAL.md: PC-08 (no validation).
  - WORKBENCH.md: CN-W01 (`banner--bad`), CN-W04, CN-W09, SH-23, FM-W03.
- **Drift.** Three error inks (danger, `--text-2`, a danger rule). The task-not-found page draws an empty state instead of an error.
- **Defects not to copy.** Silent failures with no error state: DT-11 and DN-01 accept or refuse without saying so; PC-08 has no validation (PORTAL PO-D5); AG-C61 refuses by refocusing with no message. WORKBENCH D17: CN-W02 says "Last sync failed" while CN-W04 shows fresh.

## DS-PRIM-31 Disclosure chevron

- **Purpose.** Show and hide a row's or block's detail.
- **Anatomy.** A 26 square icon button (DS-PRIM-2) with a chevron glyph pointing right when closed and down when open, `aria-expanded` on the button.
- **Variants kept.** One.
- **States.** Closed, open (`aria-expanded="true"`, glyph turned down), hover (`--text`), focus-visible (global ring).
- **Styling.** 26×26; glyph `--text-muted`; the live one types "▸"/"▾" text glyphs. Proposal: `fi-rr-angle-small-right`, rotated 90° over `--dur-fast` `--ease`.
- **Shots.**

  | Shot folder | default | hover | focus-visible | expanded |
  |---|---|---|---|---|
  | `prim02-alert-toggle` | light · dark | light · dark | light · dark | light · dark |

- **Construction.** `.alert__toggle` `A:8605`, `.alert__chev` `A:8526` and again `A:8601` (.7rem against 1rem). Other chevrons: `.chev` `A:2937`, `.layer__chev` `A:864`, `.proj__chev` `A:1575`, `.opp__chev` `A:1845`, `.kopp__chev` `A:3507`; `.wf__toggle` `A:12626`; `<details>` with ▸ in several places.
- **Usages.**
  - AGENCY.md: AG-K15, AG-E15, AG-E18, AG-S23, AG-S27.
  - CLIENT.md: BR-11, BR-31, BR-43, BR-55 to BR-58, WK-15.
  - DOCK.md: NT-08, CR-22.
  - TASKS.md: DA-03, DT-06, DT-13, DT-23.
  - WORKBENCH.md: SH-18, SH-25, SI-W01.
- **Drift.** Six chevrons in six sizes and colours; text glyphs instead of the icon font. Drop to one.
- **Defects not to copy.** `.alert__chev` declared twice with different sizes.

---

## DS-PRIM-32 Mock-data mark

Added 27 September 2026 by lane CROSSCHECK (the Astra cross-check, `../ASTRA-CROSSCHECK.md`). The catalogue had treated the pink mark as a triage overlay "not ported"; R56 (decided, ticket #302) keeps it wherever mock data shows, so it needs a home.

- **Purpose.** Tell a reader at a glance which figures and regions show sample data rather than a real source, without stopping them reading or acting on them (the owner, 7 August: "a very low-opacity pink sort of background, so you can still read and do everything", `WIRING.md:9601-9603`).
- **Anatomy.** A region class `.is-mock`: a background wash plus a 1 px inset hairline (inset so the mark never moves layout). A marked region inside a marked region keeps only its edge. Optional word chip `.unwired-tag` reading MOCK where the surrounding copy does not already say so.
- **Variants kept.** `region` (the wash and edge); `nested` (edge only); `word chip` (Mono 12 uppercase, `--tracking-label`, `--text-muted` on a 1 px `--border`, padding 0 .3rem).
- **States.** Shown only where a value's provenance is `mock`; `real` and `absent` (an explicit null, already said in words) are never marked (`mockmark.js:24-32`). On a real client nothing is mock, so the mark never shows (R56).
- **Styling.** Tokens DS-TOK-130 `--mock-pink`, DS-TOK-131 `--mock-tint` (9% light, 20% dark), DS-TOK-132 `--mock-edge` (34% light, 48% dark), mixed in `oklab`; the dark hue moves from 350 to 358 so the wash never reads as the accent violet (`app.css:10471-10497`). No radius.
- **Shots.** Region, on a verdict row of Traffic and landing: light · dark. The word chip is not cropped.
- **Construction.** `.is-mock` `app.css:10498-10511`; `.unwired-tag` `app.css:932-945`; `assets/mockmark.js` (derives the mark from `PROVENANCE`, never hand-painted); WIRING §69.
- **Usages.** WORKBENCH SH-26 (the pink mock overlay on every workbench page); any page region bound to sample data in a demo install.
- **Drift.** The unwired hatch (`[data-unwired]`, `app.css:916-922`) is a separate thing: R56 ports it as the "not connected" state (R13) or a disabled control with a tooltip, never as a hatch.
- **Defects not to copy.** The hatch over an unwired primary hides its fill (AC-03 Pay now, DS-PRIM-1). The mark must follow the data: a hand-painted `.is-mock` is the drift `mockmark.js` exists to prevent.

---

## DS-PRIM-33 Locate flash

Added 27 September 2026 by lane RECONCILE-LOOK from the fresh audit (FA-SHELL-42). The token existed (DS-TOK-83 `--dur-flash`); the look had no component.

- **Purpose.** Show where a deep link landed: one pulse on the target, so the eye finds it. It locates; it does not judge (an outline, never a fill).
- **Anatomy.** A class (`.flash-target`) put on the element a link points at when it carries `data-flash`. A disclosure target is opened first and scrolled to the centre.
- **Variants kept.** One.
- **States.** Running (once, 1.5 s), then gone. Under reduced motion the ring shows without the fade (decided: intuitive; the mockup's global reduced-motion rule zeroes durations).
- **Styling.** `box-shadow: 0 0 0 3px` accent at 75%, fading to transparent over 1.5 s (`--dur-flash`) on `--ease-out`; radius follows the target.
- **Shots.** Added at build-ready (27 September 2026, `crop.mjs`, the flash frozen at its first key frame: a 3px `--accent` ring at 75%, measured `#745cee` at 0.75). The target is the Brief's next-meeting card (`#nextMeeting`, `[data-flash]`).

  | Variant | State | Width | Light | Dark |
  |---|---|---|---|---|
  | target | default | 1480 | (screenshot, kept private) | (screenshot, kept private) |
  | target | flash | 1480 | (screenshot, kept private) | (screenshot, kept private) |
- **Construction.** `app.css:1550-1558`; applied by `portal.js:1415-1471`.
- **Usages.** Any `[data-flash]` deep-link target (SHELL, every page). Fresh audit FA-SHELL-42.
- **Drift.** None.
- **Defects not to copy.** None found.

## Primitive-like patterns handed on or not ported

- **Sort arrow** (`.table th .arrow` `A:1448`, `.conn th .arrow` `A:2920`, `.cbd__arrow` `A:7160`): part of DS-PRIM-20.
- **Delta indicator** (`.delta` `A:319-328`): part of DS-PRIM-24.
- **Star toggle** (`.proj__star` `A:5663`, `.sb__star` `A:11140`): DS-PRIM-2 with a pressed state.
- **Copy-link tick swap** (`.tpr__copy`, `assets/taskpage.js:124/175`): DS-PRIM-2 whose icon swaps link to check.
- **Legend swatch** (`.swatch` `A:360`, `.legend` `A:613`; AG-K18, AG-P26, AG-C20, AG-E7, AG-E23, MO-07, AC-02, PLB-07 `.swatch2`): charts, COMPOSITES.
- **Resize grips** (`.railgrip` `A:1467`, `.dpanel__grip` `A:4481`; SH-8, B-17, DK-14): SIDEBAR and COMPOSITES.
- **Key-value fact rows** (CR-12 to CR-15, TP-10, PH-11, PC-10, SH-23 `.srcline`): COMPOSITES; their keys cite DS-PRIM-25.
- **Unwired hatch** (`[data-unwired]` `A:916-922`): a port instruction, **not ported as a visual** (DS-X4; R56 ports it as the not-connected state or a disabled control). The **mock mark** (`assets/mockmark.js`, WIRING §69) is now DS-PRIM-32 (R56 keeps it in demo installs; corrected by the Astra cross-check).
- **Week strip, time-slot grid, date picker grid** (PH-10, PC-12, BR-21, DP-20a to DP-20d): handed to COMPOSITES, and now DS-COMP-38 (added by the Astra cross-check).

## Rulings, decided

Each was a place where the mockup's difference might be deliberate. All are ruled (26 September 2026, triage of the `DR` rulings on #297's map). Each ruling is written into its entry above. Cite the `DR` id, never the lane label.

| # | Component | Question | Proposal | Ruled |
|---|---|---|---|---|
| PR1 | DS-PRIM-1 | Keep the toggle button (pressed = ink fill) as a button variant, or fold it into DS-PRIM-10? | Keep as secondary `pressed` | DR-20 (decided): toggle = secondary `pressed` variant of DS-PRIM-1 (PR1). |
| PR2 | DS-PRIM-1 | Add a 38-tall button size to pair with inputs (six places stretch a button to 38)? | Yes, `md` | DR-21 (decided): add button size `md` 38 (PR2). |
| PR3 | DS-PRIM-1 | Primary disabled: outline (live) or grey fill (hub)? | Outline | DR-22 (decided): primary disabled is an outline (live mockup; PR3). |
| PR4 | DS-PRIM-2 | Keep a 22 compact icon button for dense rows? | Yes | DR-23 (decided): keep the 22 compact icon button (PR4). |
| PR5 | DS-PRIM-2 | Keep hover-reveal (hidden until row hover) controls? | Yes, but always visible on touch and on focus | DR-24 (decided): hover reveal kept above 900, at rest below 900 (R37), visible on focus. |
| PR6 | DS-PRIM-3/4 | Field ground: paper everywhere, or `--surface-2` on the client face? | Paper, one ground | DR-25 (decided): one paper field ground on both faces (PR6; no duplicates). |
| PR7 | DS-PRIM-4 | Task brief textarea in mono (panel) or sans (task page)? | Mono in both | DR-26 (decided): already R60, sans description, mono only for Agent MD. |
| PR8 | DS-PRIM-9 | Switch "on" knob: `--success` fill (breaks the no-fill rule) or an ink knob with a success border? | Ink knob, success border | DR-27 (decided): switch on = ink knob, success border (house no-fill rule; PR8). |
| PR9 | DS-PRIM-10 | Two pressed looks (ink fill for view switches, accent outline for filters): keep both? | Keep both, named | DR-28 (decided): two named pressed looks, view switch ink, filter accent outline (PR9). |
| PR10 | DS-PRIM-11 | Chips in the dock are square, elsewhere pills: which? | Pills everywhere | DR-29 (decided): chips are pills everywhere (house rule; PR10). |
| PR11 | DS-PRIM-11 | Keep the dashed "pin" chip and the square `.vaultpill`? | Drop both | DR-30 (decided): `pinChip` and `.vaultpill` fold into the outline chip, content kept (PR11). |
| PR12 | DS-PRIM-12 | Keep the badge as its own component, or fold into marker and count? | Fold | DR-31 (decided): DS-PRIM-12 badge folds into marker and count (PR12). |
| PR13 | DS-PRIM-13 | Counts: square (live) or pill (DS)? | Square | DR-32 (decided): counts are square (live; WIRING.md:5791). |
| PR14 | DS-PRIM-15 | One status tone vocabulary (ok, run, gate, warn, bad, idle) replacing `is-*` and `data-tone`? | Yes | DR-33 (decided): one tone set ok/run/gate/warn/bad/idle (PR14; CD-1 naming). |
| PR15 | DS-PRIM-16 | People round, clients square? | Yes | DR-34 (decided): people round, clients square, as drawn (PR15). |
| PR16 | DS-PRIM-21 | Keep the accent-left-rule card (`--flagged`) for AI and recommendation cards? | Yes, 2px | DR-35 (decided): keep `--flagged` card, 2px accent rule (PR16). |
| PR17 | DS-PRIM-21 | Interactive cards lift 1px on hover, against "rows never move"? | No lift; border only | DR-2 (decided): border-only hover, no lift (both lanes; one hover rule). |
| PR18 | DS-PRIM-22 | Keep `.hint` (accent wash, the agent's aside) as a banner variant? | Yes | DR-5 (decided): `.hint` is a named DS-PRIM-22 variant (agent aside), not folded into info (PR18). |
| PR19 | DS-PRIM-24 | Keep the Display 128 scene number (WK-10) and the portal hero figure as exceptions? | Yes, as COMPOSITES scene parts | DR-7 (decided): hero-only exceptions owned by DS-COMP-31 (both lanes; R53 named exceptions). |
| PR20 | DS-PRIM-28 | Remove a section at zero (live in five places) or always show an empty state? | Always show | DR-36 (decided): sections always show, with an empty state at zero (PR20; WIRING section 34). |
| PR21 | DS-PRIM-29 | Adopt the three loading patterns proposed? | Yes | DR-37 (decided): adopt PRIMITIVES' three loading patterns for DS-PRIM-29 (PR21). |
| PR22 | DS-PRIM-30 | Row error notes in `--text-2` rather than red? | Yes | DR-38 (decided): row error notes in `--text-2` (PR22). |
| PR23 | Shared | One focus ring (drop the button outline)? | Yes | DR-1 (decided): one global focus ring, one token value, component outlines dropped (DIRECTION no-duplicates; PR23). |

## Old id to new id

| Old id (SHELL.md section 1) | What | New id |
|---|---|---|
| DS-K1 | `.btn` | DS-PRIM-1 |
| DS-K2 | `.btn--primary` | DS-PRIM-1 (variant `--primary`) |
| DS-K3 | `.btn` variants and sizes; `--icon` | DS-PRIM-1; `--icon` to DS-PRIM-2 |
| DS-K4 | `.chip` | DS-PRIM-11 |
| DS-K5 | `.segmented` | DS-PRIM-10 |
| DS-K6 | `.meter` | DS-PRIM-23 |
| DS-K7 | `.table` | DS-PRIM-20 |
| DS-K8 | `.card` | DS-PRIM-21 |
| DS-K9 | `.banner` (and `.banner__x`) | DS-PRIM-22 (dismiss is DS-PRIM-2) |
| DS-K10 | Tooltip `.term` | DS-PRIM-18 |
| DS-K11 | Dock-tab callout | DS-PRIM-18 (placement: SIDEBAR) |
| DS-K12 | `.marker`, `.u-tag`, `.stamp`, `.index` | DS-PRIM-25 |
| DS-K13 | `statusDot`, `statusChip`, `statusPill` | DS-PRIM-14 (dot) and DS-PRIM-15 (chip, text) |
| DS-K14 | `.stat`, `kpi`, `kpiSm` | DS-PRIM-24 |
| DS-K15 | `freshness()`, `.marker.fresh` | DS-PRIM-25 (freshness) |
| DS-K16 | `.switch`, `.input`, `.field`, `.badge`, `.count`, `.dot` | DS-PRIM-9, DS-PRIM-3, DS-PRIM-3, DS-PRIM-12 (folded by DR-31), DS-PRIM-13, DS-PRIM-14 |
| DS-K17 | `.u-pill` | DS-PRIM-11 |
| DS-F1 | Global focus ring | Shared state rules (this file) |
| DS-F2 | Button focus outline | DS-PRIM-1 (dropped, DR-1) |
| DS-F3 | Hover rules in the shell | Rail, tab, appbar and dock rows: SIDEBAR and COMPOSITES; segmented: DS-PRIM-10 |
| DS-F4 | Door marks follow their host | DS-PRIM-17 |
| DS-F5 | Rail fold focus | SIDEBAR |
| DS-X1 | Empty | DS-PRIM-28 |
| DS-X2 | Loading | DS-PRIM-29 |
| DS-X3 | Error | DS-PRIM-30 |
| DS-X4 | Unwired | Not ported as a visual (handed on above) |
| DS-X5 | Mock mark | DS-PRIM-32 (R56; corrected by the Astra cross-check) |
| DS-I1 | Icon font | DS-PRIM-17 |
| DS-I2 | Door-mark vocabulary | DS-PRIM-17, DS-PRIM-26 |
| DS-I3 | Door-mark dress | DS-PRIM-17 |
| DS-I4 | Logos | SIDEBAR (rail) and COMPOSITES (app strip) |
| DS-I5 | No emoji, ever | DS-PRIM-17 (rule stands) |
