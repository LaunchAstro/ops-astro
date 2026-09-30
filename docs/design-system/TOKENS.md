<!-- Public edition, generated from the private design-system source by ticket C82's build and checked by the real-names check before it crossed. Do not edit it here; the source changes and the copy is run again. Screenshots and review records stay private, so they are not linked. -->

# Ops Astro design system: the canonical token set

Lane TOKENS, design-system pass wave 1, 26 September 2026. Wayfinder ticket: "Chart the canonical token set (#289)" on the map "Ops Astro design system". This file answers to `DIRECTION.md`: one design system, one home, no duplicates. Every colour, size, space, radius, shadow, motion value, breakpoint, layer and icon size the mockup uses is named here once, with a `DS-TOK-<n>` id. Every alias, near-duplicate and stray literal in the mockup points to one of these ids or is marked as drift.

Plan and document only. Nothing here is built.

## How to read this

- **Canonical names are the semantic layer** (`--bg`, `--surface`, `--text`, `--border`, `--accent`), because that is what components reference. The foundation primitives (`--paper`, `--ink`, `--ink-muted`, `--ink-faint`, `--rule-faint`) are aliases that map to them. Where an alias resolves to a different value in dark, that is drift and is called out.
- **Proposed** tokens do not exist in the mockup today. Each names a value the mockup already repeats as a literal (for example `z-index: 60` or `.35rem`), so the build can reference it once. "Proposed" is a provenance label, not a question: every proposed token is adopted for the build (the rulings: TICKET-PLAN R53 for type, DR-11 for the wash, DR-16 for the half steps, DR-17 for the z ladder).
- **Tolerances**: sizes within 2 px of a token are near-duplicates; colours within ΔE00 (CIEDE2000) 2.0 of a token are near-duplicates. Colours with alpha are composited over `--bg` of the same theme before comparing.
- **Measured** means read in headless Chrome from the served mockup (`http://127.0.0.1:8791`, `/dashboard/`, 1480 wide, light and dark), with every stylesheet walked, including the `@import`ed `hub-ds/*.css` and `@media` blocks. The inventory's `tokens-{light,dark}.json` saw only 35 top-level properties; this pass resolves 157 referenced names and 180 declared ones (279 declarations: `tokens.css` 25, `hub-ds/*.css` 228, `app.css` 26).
- **CSS refs** counts `var()` references to the token and its aliases across `tokens.css`, `hub-ds/*.css` and `app.css`. **Inventory ids** counts element rows in `docs/mockup-inventory/` that cite the token or an alias by name. The ids themselves are in the appendix.
- Tokens have no anatomy or states in the component sense. Each group states that once instead of repeating it per row.
- Construction citations are evidence of intent, not clean code (DIRECTION.md). `file:line` is in `dashboard-mockups/assets/` unless the path says otherwise.

## Counts

- **132 canonical ids**: 109 single-value tokens (27 of them proposed) and 23 canonical text styles. DS-TOK-130 to DS-TOK-132 (the mock-data mark) were added by the Astra cross-check on 27 September. They are numbered after the text styles because ids are never renumbered.
- Colour: 27 canonical colour tokens replace 54 colour names the mockup uses or declares, plus 77 uses of colour-mix recipes and literal colours (27 map to a token, 50 stay component tints or need a ruling).
- Type: the census (below) found **144 distinct text styles in 3584 text nodes over 17 routes**; they map to **23 canonical text styles** (27 exact, 93 drift to drop, 14 `could be deliberate`, 10 glyphs that are icons). The census verdict `could be deliberate` is a measurement label. Every such row is now ruled (see "How the rulings apply to the census" under the census method).
- Literals in `app.css`: font sizes 579 of 597 literal declarations map to a size token within 2 px; spacing 647 of 663 map to a spacing step. `app.css` holds only two literal colours (`oklch(0 0 0 / .4)` at :661 and the client teal at :2682). Colour discipline is already good, the drift is in the `color-mix()` recipes and the dark-mode aliases.

## Shots

Specimen sheets built from the mockup's own stylesheets (`tokens.css` and `hub-ds/index.css` linked from the served mockup, never edited; `app.css` tokens and the proposed tokens restated in the specimen page). Width 1480; tokens do not change with width, so there are no 900 or 390 shots. Source page: `.local/design-system-2026-09-26/lane-scratch/TOKENS/specimen.html`.

| Sheet | Light | Dark |
|---|---|---|
| Colour: grounds, text, lines (DS-TOK-1 to 12) | light | dark |
| Colour: accent, on-dark, chrome, status, proposed (DS-TOK-13 to 27) | light | dark |
| Alias drift: canonical against the mockup alias it replaces | light | dark |
| Easing curves (--ease against the drift `ease` keyword and linear) and the duration ladder | light | dark |
| Spacing ladder, radii, shadows and the focus ring | light | dark |
| Text styles in Funnel Display | light | dark |
| Text styles in Chivo Mono | light | dark |
| Text styles in Funnel Sans | light | dark |

## The canonical tokens

### Colour

Anatomy: one colour value. Variants kept: light and dark. States: none of its own; state colours are separate tokens (--hover-accent, --accent-ring, --focus-ring, --text-dim, --accent-wash). Source values are OKLCH or `color-mix()`. The sRGB beside each is what Chrome paints (measured on `/dashboard/` at 1480 with `--force-color-profile=srgb`). Alpha values are shown as `#rrggbb / a`.

| ID | Token | Purpose | Light (source → sRGB) | Dark (source → sRGB) | Construction (`file:line` in dashboard-mockups/assets) | Aliases mapped here | CSS refs | Inventory ids |
|---|---|---|---|---|---|---|---|---|
| DS-TOK-1 | `--bg` | Page ground; the one ground every page sits on | `var(--paper)` → #ffffff | `var(--void)` → #0a0a0d | `tokens.css:105` (dark), `hub-ds/colors.css:49`, `hub-ds/colors.css:113` (dark), `hub-ds/colors.css:152` (light re-assert) | `--paper`, `--btn-text`, `--bg-deep` | 114 | 56 |
| DS-TOK-2 | `--surface` | Card and panel ground | `var(--paper)` → #ffffff | `color-mix(in oklch, var(--on-dark) 3%, var(--void))` → #0f0f12 | `tokens.css:106` (dark), `hub-ds/colors.css:51`, `hub-ds/colors.css:115` (dark), `hub-ds/colors.css:154` (light re-assert) | - | 67 | 62 |
| DS-TOK-3 | `--surface-2` | Hover fill, chip fill, quiet wells | `color-mix(in oklch, var(--ink) 4%, var(--paper))` → #f2f2f2 | `color-mix(in oklch, var(--on-dark) 7%, var(--void))` → #171619 | `tokens.css:107` (dark), `hub-ds/colors.css:52`, `hub-ds/colors.css:116` (dark), `hub-ds/colors.css:155` (light re-assert) | - | 61 | 48 |
| DS-TOK-4 | `--surface-3` | Meter track, pressed well | `color-mix(in oklch, var(--ink) 8%, var(--paper))` → #e4e4e4 | `color-mix(in oklch, var(--on-dark) 11%, var(--void))` → #1e1e21 | `tokens.css:108` (dark), `hub-ds/colors.css:53`, `hub-ds/colors.css:117` (dark), `hub-ds/colors.css:156` (light re-assert) | - | 7 | 2 |
| DS-TOK-5 | `--rail-bg` | Sidebar rail and dock rail ground (off-white in light, void in dark) | `#f7f7f7` → #f7f7f7 | `var(--bg)` → #0a0a0d | `tokens.css:65`, `tokens.css:81` (dark) | - | 12 | 4 |
| DS-TOK-6 | `--text` | Primary text and icons | `var(--ink)` → #000000 | `var(--on-dark)` → #f8f8f8 | `tokens.css:111` (dark), `hub-ds/colors.css:56`, `hub-ds/colors.css:120` (dark), `hub-ds/colors.css:159` (light re-assert) | `--ink`, `--btn-fill`, `--btn-outline`, `--text-1` | 330 | 229 |
| DS-TOK-7 | `--text-2` | Secondary text; idle rail items and tabs | `var(--ink-muted)` → #6b635d | `var(--on-dark-muted)` → #f8f8f8 / 0.72 | `tokens.css:112` (dark), `hub-ds/colors.css:57`, `hub-ds/colors.css:121` (dark), `hub-ds/colors.css:160` (light re-assert) | `--ink-muted` | 168 | 100 |
| DS-TOK-8 | `--text-muted` | Captions, meta, idle icons | `var(--ink-faint)` → #8c857f | `color-mix(in oklch, var(--on-dark) 55%, transparent)` → #f8f8f8 / 0.55 | `tokens.css:113` (dark), `hub-ds/colors.css:58`, `hub-ds/colors.css:122` (dark), `hub-ds/colors.css:161` (light re-assert) | `--ink-faint` | 448 | 297 |
| DS-TOK-9 | `--text-dim` | Disabled text and disabled fill | `color-mix(in oklch, var(--ink-faint) 60%, var(--paper))` → #b9b3b2 | `color-mix(in oklch, var(--on-dark) 36%, transparent)` → #f7f7f7 / 0.36 | `hub-ds/colors.css:59`, `hub-ds/colors.css:123` (dark), `hub-ds/colors.css:162` (light re-assert) | - | 23 | 8 |
| DS-TOK-10 | `--border` | Hairlines: card edges, row rules, inputs | `var(--rule-faint)` → #000000 / 0.12 | `color-mix(in oklch, var(--on-dark) 10%, transparent)` → #f5f5f5 / 0.10 | `tokens.css:109` (dark), `hub-ds/colors.css:54`, `hub-ds/colors.css:118` (dark), `hub-ds/colors.css:157` (light re-assert) | `--rule-faint` | 325 | 126 |
| DS-TOK-11 | `--border-strong` | Stronger outline: segmented controls, nav toggle, dashed drop zones | `color-mix(in oklch, var(--ink) 32%, transparent)` → #000000 / 0.32 | `color-mix(in oklch, var(--on-dark) 20%, transparent)` → #fafafa / 0.20 | `tokens.css:110` (dark), `hub-ds/colors.css:55`, `hub-ds/colors.css:119` (dark), `hub-ds/colors.css:158` (light re-assert) | - | 97 | 48 |
| DS-TOK-12 | `--rule` | Heavy rule: table header underline, section rules | `oklch(0 0 0)` → #000000 | `oklch(1 0 0 / 0.24)` → #ffffff / 0.24 | `tokens.css:97` (dark), `hub-ds/foundation.css:40` | - | 21 | 12 |
| DS-TOK-13 | `--accent` | The one violet: rail mark, tab mark, count chip, focus ring, links on hover | `oklch(0.58 0.21 285)` → #745cee | `oklch(0.58 0.21 285)` → #745cee | `hub-ds/colors.css:27`, `hub-ds/colors.css:101` (dark), `hub-ds/colors.css:143` (light re-assert) | `--brand`, `--btn-hover` | 258 | 140 |
| DS-TOK-14 | `--hover-accent` | Hover ink for text links: accent in light, --text in dark | `var(--accent)` → #745cee | `var(--text)` → #f8f8f8 | `hub-ds/colors.css:46`, `hub-ds/colors.css:111` (dark), `hub-ds/colors.css:150` (light re-assert) | - | 4 | 1 |
| DS-TOK-15 | `--accent-ring` | Focus and selection halo: accent 35% light, 55% dark | `color-mix(in oklch, var(--accent) 35%, transparent)` → #735cee / 0.35 | `color-mix(in oklch, var(--accent) 55%, transparent)` → #755def / 0.55 | `hub-ds/colors.css:31`, `hub-ds/colors.css:102` (dark), `hub-ds/colors.css:144` (light re-assert) | `--brand-ring`, `--accent-hover` | 12 | 1 |
| DS-TOK-16 | `--on-dark` | Ink on any dark or coloured ground: app strip, accent fills, tooltips, hero | `oklch(0.98 0 0)` → #f8f8f8 | same → #f8f8f8 | `hub-ds/foundation.css:38` | `--accent-ink`, `--brand-ink`, `--btn-hover-text`, `--face-chrome-ink`, `--app-ink`, `--hero-ink`, `--mark-color` | 63 | 7 |
| DS-TOK-17 | `--on-dark-muted` | Secondary ink on dark grounds (tooltips) | `color-mix(in oklch, var(--on-dark) 72%, transparent)` → #f8f8f8 / 0.72 | same → #f8f8f8 / 0.72 | `hub-ds/foundation.css:39` | - | 1 | - |
| DS-TOK-18 | `--void` | The dark ground constant: dark page ground, tooltip ground | `oklch(0.145 0.006 285)` → #0a0a0d | same → #0a0a0d | `hub-ds/foundation.css:36` | `--void-deep` | 11 | 2 |
| DS-TOK-19 | `--app-chrome` | App strip ground (agency face); lifts to #222226 in dark | `var(--client-brand)` → #0a0a0d | `var(--face-chrome)` → #222226 | `app.css:2681`, `app.css:2687` (dark), `app.css:2688` | `--face-chrome` | 10 | 1 |
| DS-TOK-20 | `--client-brand` | App strip ground on the client face (teal) | `oklch(0.33 0.058 192)` → #003f3d | same → #003f3d | `app.css:2682` | - | 1 | 2 |
| DS-TOK-21 | `--info` | Status: information (outline, number or line, never a fill) | `#009dea` → #009dea | `#38b6f1` → #38b6f1 | `hub-ds/colors.css:72`, `hub-ds/colors.css:129` (dark), `hub-ds/colors.css:167` (light re-assert) | `--blue` | 7 | 11 |
| DS-TOK-22 | `--success` | Status: good | `#10b981` → #10b981 | `#34d399` → #34d399 | `hub-ds/colors.css:73`, `hub-ds/colors.css:130` (dark), `hub-ds/colors.css:168` (light re-assert) | `--green` | 26 | 37 |
| DS-TOK-23 | `--warning` | Status: attention; dashed connectors for blocked | `#f59e0b` → #f59e0b | `#fbbf24` → #fbbf24 | `hub-ds/colors.css:74`, `hub-ds/colors.css:131` (dark), `hub-ds/colors.css:169` (light re-assert) | `--orange` | 51 | 49 |
| DS-TOK-24 | `--danger` | Status: bad, destructive | `#e84a5f` → #e84a5f | `#f87171` → #f87171 | `hub-ds/colors.css:75`, `hub-ds/colors.css:132` (dark), `hub-ds/colors.css:170` (light re-assert) | `--rose` | 54 | 38 |
| DS-TOK-25 | `--scrim` (proposed) | Backdrop behind the off-canvas rail and modal sheets | `oklch(0 0 0 / 0.4)` | `oklch(0 0 0 / 0.4)` | literal today; see the literal tables | - | 0 | - |
| DS-TOK-26 | `--accent-wash` (proposed) | The only accent tint: selected row, armed drop zone, today column | `color-mix(in oklch, var(--accent) 8%, transparent)` | `color-mix(in oklch, var(--accent) 8%, transparent)` | literal today; see the literal tables | - | 0 | - |
| DS-TOK-27 | `--hero-paint` | Cover-photo fallback gradient (teal to navy); does not flip | `linear-gradient(135deg, #0E7C7B 0%, #17555A 42%, #14243B 100%)` → `linear-gradient(135deg, #0E7C7B 0%, #17555A 42%, #14243B 100%)` | same → `linear-gradient(135deg, #0E7C7B 0%, #17555A 42%, #14243B 100%)` | `tokens.css:77` | - | 1 | 2 |

Drift, near-duplicates and defects:

- **DS-TOK-1 `--bg`** · --bg-deep: light = paper, dark = --void-deep #020203 (ΔE00 1.6 against --bg dark, a near-duplicate); 1 use (`hub-ds/base.css`). Verdict: drop.
- **DS-TOK-2 `--surface`** · light: identical to --bg in light; only dark lifts it (on-dark 3% over void). Verdict: keep, the lift is the dark card edge (decided at build-ready: the look is canonical, DIRECTION point 6).
- **DS-TOK-3 `--surface-2`** · tokens.css:107: dark bridge sets ink 5% over paper; colors.css:116 (on-dark 7%) loads later and wins, so the bridge line is dead. Verdict: drop the dead line.
- **DS-TOK-4 `--surface-3`** · tokens.css:108: dead dark bridge line (9%), overridden by colors.css:117 (11%). Verdict: drop.
- **DS-TOK-5 `--rail-bg`** · --bg: light #f7f7f7 is ΔE00 1.6 from --bg #ffffff (under the 2.0 line), identical in dark. Verdict: keep, the rail reads as its own plane (DR-18).
- **DS-TOK-6 `--text`** · --btn-outline: light = ink; dark = on-dark 55% (#8c8c8d), which is --text-muted, not --text. Verdict: map to --border-strong/--text-muted by role (PRIMITIVES lane).
- **DS-TOK-7 `--text-2`** · --ink-muted (dark): tokens.css:95 sets on-dark 66% (#a6a6a7); --text-2 is on-dark 72% (#b5b5b6); ΔE00 4.3, so the two names split in dark. Verdict: one value, 72% (decided at build-ready under TICKET-PLAN R53's no-duplicates rule).
- **DS-TOK-8 `--text-muted`** · --ink-faint (dark): tokens.css:96 sets on-dark 46% (#777779); --text-muted is on-dark 55% (#8c8c8d); ΔE00 7.9; --ink-faint has 182 uses, --text-muted 266. Verdict: ruled by DR-10: `--ink-faint` folds into `--text-muted` at 55% in both themes.
- **DS-TOK-10 `--border`** · --rule-faint (dark): tokens.css:98 sets white 14% (#2c2c2f composited); --border dark is on-dark 10% (#1e1e21 composited); split in dark only. Verdict: map --rule-faint to --border.
- **DS-TOK-11 `--border-strong`** · tokens.css:110: dead dark bridge line (ink 38%), overridden by colors.css:119 (on-dark 20%), the same pattern as DS-TOK-3 and DS-TOK-4. Verdict: drop the dead line. (Added by the Astra cross-check.)
- **DS-TOK-14 `--hover-accent`** · dark: flips to --text in dark (colors.css:111). Verdict: keep: deliberate, violet on void is too loud.
- **DS-TOK-15 `--accent-ring`** · --brand-ring: resolved once at :root, so it never takes the dark 55%; unused. Verdict: drop.
- **DS-TOK-15 `--accent-ring`** · --accent-hover: accent 85% into ink (#6e42b8), declared, never used. Verdict: drop.
- **DS-TOK-16 `--on-dark`** · --hero-ink, --mark-color: #ffffff against #f8f8f8, ΔE00 1.4. Verdict: map to --on-dark.
- **DS-TOK-18 `--void`** · --void-deep: #020203, 1 use; ΔE00 1.6 from --void, a near-duplicate. Verdict: drop, use --void.
- **DS-TOK-21 `--info`** · --blue: declared at :root as var(--info), so it stays light in dark; unused. Verdict: drop.
- **DS-TOK-22 `--success`** · --green: same :root freeze as --blue; unused. Verdict: drop.
- **DS-TOK-23 `--warning`** · --orange: same :root freeze; unused. Verdict: drop.
- **DS-TOK-24 `--danger`** · --rose: same :root freeze; unused. Verdict: drop.
- **DS-TOK-24 `--danger`** · *-soft: --info-soft, --success-soft, --warning-soft, --danger-soft, --accent-soft and the colour-name softs are all `transparent`. Verdict: drop: the law is status is never a fill.
- **DS-TOK-21 to DS-TOK-24, small status text** · the light status colours used as the colour of small text fail contrast on white: `--info` #009dea 3.00:1, `--success` #10b981 2.54:1, `--warning` #f59e0b 2.15:1, `--danger` #e84a5f 3.77:1, against 4.5:1 for body-size text (computed 27 Sep; status text at 12 px, for example `ui.js:163`, `charts.js:270`). As lines, rules and icons they pass the 3:1 non-text bar only for info and danger. Verdict: a defect in the look, not a token to copy blindly; small status text gets darker light-theme text variants (Astra's #0076b0 4.98, #047857 5.48, #92400e 7.09, #be123c 6.29), used only as the colour of small status text; the drawn colours stay for lines, rules and icons, and dark already passes (DR-65, ruled by the owner on 27 September: `CAPABILITY-SLICES.md`, "Owner answers" item 9). The variants are light-theme text values of DS-TOK-21 to DS-TOK-24, not new ids, so the token count is unchanged. (Added by the Astra cross-check.)
- **DS-TOK-25 `--scrim`** · app.css:661: `.navbackdrop` literal oklch(0 0 0 / .4). Verdict: becomes --scrim.
- **DS-TOK-25 `--scrim`** · hub-ds/primitives.css:402: rgba(0,0,0,.4). Verdict: becomes --scrim.
- **DS-TOK-25 `--scrim`** · hub-ds/foundation.css:89: rgba(0,0,0,.45) (in --shadow-overlay family). Verdict: keep in the shadow.
- **DS-TOK-26 `--accent-wash`** · accent 4%, 6%, 8%, 14% recipes: six recipes (app.css:383, 406, 538, 1366, 2122, 2431, 6316, 9711) at 4 to 14%. Verdict: ruled by DR-11: one `--accent-wash` at 8%.

### Type primitives: families

Anatomy: one value. Variants kept: one (these tokens do not flip with the theme unless the Dark column says so). States: none.

| ID | Token | Purpose | Value (source → resolved at 1480) | Dark | Construction (`file:line` in dashboard-mockups/assets) | Aliases mapped here | CSS refs | Inventory ids |
|---|---|---|---|---|---|---|---|---|
| DS-TOK-28 | `--font-display` | Funnel Display 400 to 700: titles, section heads, big numbers, the rail HUB label | `"Funnel Display", system-ui, -apple-system, sans-serif` | same | `hub-ds/typography.css:25` | - | 30 | - |
| DS-TOK-29 | `--font-sans` | Funnel Sans 400 to 600: body, UI text, buttons | `"Funnel Sans", system-ui, -apple-system, "Segoe UI", sans-serif` | same | `hub-ds/typography.css:26` | - | 33 | - |
| DS-TOK-30 | `--font-mono` | Chivo Mono 300 to 500: data, dates, eyebrows, chips, counts | `"Chivo Mono", ui-monospace, SFMono-Regular, monospace` | same | `hub-ds/typography.css:27` | - | 206 | - |

Drift, near-duplicates and defects:

- **DS-TOK-30 `--font-mono`** · `code`: browser `monospace` on `code` (5 routes): the reset never sets --font-mono on code. Verdict: map to --font-mono.

### Type primitives: weights

Anatomy: one value. Variants kept: one (these tokens do not flip with the theme unless the Dark column says so). States: none.

| ID | Token | Purpose | Value (source → resolved at 1480) | Dark | Construction (`file:line` in dashboard-mockups/assets) | Aliases mapped here | CSS refs | Inventory ids |
|---|---|---|---|---|---|---|---|---|
| DS-TOK-31 | `--weight-light` | 300: mono eyebrows and tags | `300` | same | `hub-ds/typography.css:70` | - | 8 | - |
| DS-TOK-32 | `--weight-regular` | 400: body | `400` | same | `hub-ds/typography.css:71` | `--weight-body` | 11 | - |
| DS-TOK-33 | `--weight-medium` | 500: emphasis, active items, display heads, buttons | `500` | same | `hub-ds/typography.css:73` | - | 76 | - |
| DS-TOK-34 | `--weight-semibold` | 600: card titles | `600` | same | `hub-ds/typography.css:74` | - | 10 | - |

Drift, near-duplicates and defects:

- **DS-TOK-34 `--weight-semibold`** · 700: `<strong>`/`<b>` compute 700 (41 + 24 + 13 nodes); no 700 face is loaded for Sans (400 to 600) or Mono (300 to 500), so Sans renders its 600 face and Mono synthesises bold. Verdict: drop: set strong to --weight-medium or --weight-semibold.

### Type primitives: sizes

Anatomy: one value. Variants kept: one (these tokens do not flip with the theme unless the Dark column says so). States: none.

| ID | Token | Purpose | Value (source → resolved at 1480) | Dark | Construction (`file:line` in dashboard-mockups/assets) | Aliases mapped here | CSS refs | Inventory ids |
|---|---|---|---|---|---|---|---|---|
| DS-TOK-35 | `--text-display` | clamp(28px, 4vw, 44px): hero and verdict lines | `clamp(28px, 4vw, 44px)` → 44px | same | `hub-ds/typography.css:30` | `--fs-h3`, `--fs-display`, `--fs-h2`, `--fs-body` | 3 | 1 |
| DS-TOK-36 | `--fs-title` | clamp(24px, 2.4vw, 28px): section heads (28 at 1480) | `clamp(1.5rem, 2.4vw, 1.75rem)` → 28px | same | `hub-ds/typography.css:51` | - | 4 | - |
| DS-TOK-37 | `--text-h1` | 24px: page title | `24px` | same | `hub-ds/typography.css:31` | - | 1 | - |
| DS-TOK-38 | `--text-h2` | 20px: panel and brief headings | `20px` | same | `hub-ds/typography.css:32` | `--fs-lead` | 9 | 3 |
| DS-TOK-39 | `--text-h3` | 16px: subheadings, group heads | `16px` | same | `hub-ds/typography.css:33` | - | 7 | 1 |
| DS-TOK-40 | `--text-body-lg` | 15px: lead body, card titles | `15px` | same | `hub-ds/typography.css:34` | - | 1 | - |
| DS-TOK-41 | `--text-body` | 14px: body | `14px` | same | `hub-ds/typography.css:35` | `--fs-mono` | 6 | - |
| DS-TOK-42 | `--text-sm` | 13px: secondary copy, appbar text | `13px` | same | `hub-ds/typography.css:36` | - | 142 | 4 |
| DS-TOK-43 | `--text-label` | 12px: mono data, eyebrows, small buttons | `12px` | same | `hub-ds/typography.css:37` | `--fs-mono-sm` | 265 | - |
| DS-TOK-44 | `--text-overline` | 11px: chips, keycaps | `11px` | same | `hub-ds/typography.css:38` | - | 29 | - |
| DS-TOK-45 | `--text-micro` (proposed) | 10px: counts and badges (dock count, category badge); today a literal .625rem | `10px` | same | literal today; see the literal tables | - | 0 | - |
| DS-TOK-46 | `--text-num-lg` | 34px: stat numbers | `34px` | same | `hub-ds/typography.css:41` | - | 1 | - |
| DS-TOK-47 | `--text-num-md` | 26px: verdict values | `26px` | same | `hub-ds/typography.css:42` | `--text-num-xs` | 3 | 2 |
| DS-TOK-48 | `--text-num-sm` | 22px: source-box values | `22px` | same | `hub-ds/typography.css:43` | - | 1 | 1 |

Drift, near-duplicates and defects:

- **DS-TOK-35 `--text-display`** · --fs-h3: clamp(28px, 3vw, 36px), 2 uses. Verdict: map to --text-display.
- **DS-TOK-35 `--text-display`** · --fs-display, --fs-h2, --fs-body: Hub marketing sizes, unused. Verdict: drop.
- **DS-TOK-36 `--fs-title`** · page title: the section head (28) is larger than the page title (24). Verdict: ruled by DR-12: keep the section head 28 over the page title 24, as drawn.
- **DS-TOK-38 `--text-h2`** · --fs-lead: 18px, 7 uses (lead copy and 18px display heads). Verdict: ruled by DR-13: `--fs-lead` folds into `--text-h2` 20.
- **DS-TOK-47 `--text-num-md`** · --text-num-xs: 17px, unused. Verdict: drop.

### Type primitives: line heights

Anatomy: one value. Variants kept: one (these tokens do not flip with the theme unless the Dark column says so). States: none.

| ID | Token | Purpose | Value (source → resolved at 1480) | Dark | Construction (`file:line` in dashboard-mockups/assets) | Aliases mapped here | CSS refs | Inventory ids |
|---|---|---|---|---|---|---|---|---|
| DS-TOK-49 | `--leading-none` (proposed) | 1: single-line UI (chips, buttons, counts, big numbers); today the literal `1`, 91 declarations | `1` | same | literal today; see the literal tables | `--lh-tight` | 1 | - |
| DS-TOK-50 | `--lh-title` | 1.1: display heads | `1.1` | same | `hub-ds/typography.css:61` | `--leading-tight` | 7 | - |
| DS-TOK-51 | `--lh-body` | 1.4: dense rows and meta | `1.4` | same | `hub-ds/typography.css:62` | `--leading-snug` | 29 | - |
| DS-TOK-52 | `--leading-normal` | 1.55: body default (hub-ds/base.css:25) | `1.55` | same | `hub-ds/typography.css:59` | - | 2 | - |

Drift, near-duplicates and defects:

- **DS-TOK-49 `--leading-none`** · --lh-tight: 0.9, 1 use (hero number). Verdict: map to --leading-none.
- **DS-TOK-50 `--lh-title`** · --leading-tight: 1.15 (Hub base h1 to h3), 4 uses; 1.2 literal ×6, 1.25 ×5. Verdict: map to --lh-title (under 1 px at 24px).
- **DS-TOK-51 `--lh-body`** · --leading-snug: 1.35, 4 uses; 1.3 ×4, 1.35 ×8 literals. Verdict: map to --lh-body (0.7 px at 14px).
- **DS-TOK-52 `--leading-normal`** · 1.5, 1.45, 1.6, 1.7 literals: 31 + 18 + 2 + 2 declarations. Verdict: ruled by DR-14: one reading line height, 1.55 (`--leading-normal`).

### Type primitives: tracking

Anatomy: one value. Variants kept: one (these tokens do not flip with the theme unless the Dark column says so). States: none.

| ID | Token | Purpose | Value (source → resolved at 1480) | Dark | Construction (`file:line` in dashboard-mockups/assets) | Aliases mapped here | CSS refs | Inventory ids |
|---|---|---|---|---|---|---|---|---|
| DS-TOK-53 | `--tracking-display` | -0.03em: big numbers and hero | `-0.03em` | same | `hub-ds/typography.css:65` | - | 6 | - |
| DS-TOK-54 | `--tracking-tight` | -0.01em: display heads, buttons | `-0.01em` | same | `hub-ds/typography.css:66` | - | 7 | - |
| DS-TOK-55 | `--tracking-label` | +0.02em: mono uppercase eyebrows and tags | `0.02em` | same | `hub-ds/typography.css:67` | - | 105 | 1 |
| DS-TOK-56 | `--tracking-caps` (proposed) | +0.06em: chips (11px mono uppercase); today literal .06em (app.css:59, 11313), .08em ×1 | `0.06em` | same | literal today; see the literal tables | - | 0 | - |

Drift, near-duplicates and defects:

- **DS-TOK-55 `--tracking-label`** · .04em, .045em literals: 4 declarations (mstrip, board heads). Verdict: map to --tracking-label.

### Spacing

Anatomy: one value. Variants kept: one (these tokens do not flip with the theme unless the Dark column says so). States: none.

| ID | Token | Purpose | Value (source → resolved at 1480) | Dark | Construction (`file:line` in dashboard-mockups/assets) | Aliases mapped here | CSS refs | Inventory ids |
|---|---|---|---|---|---|---|---|---|
| DS-TOK-57 | `--s-0-5` (proposed) | 2px: hairline gaps; absorbs the .05rem to .18rem, 1px and 2px literals (104 declarations, negatives included) | `2px` | same | literal today; see the literal tables | - | 0 | - |
| DS-TOK-58 | `--s-1` | 4px | `0.25rem` → 4px | same | `hub-ds/spacing.css:14` | `--space-1` | 13 | - |
| DS-TOK-59 | `--s-1-5` (proposed) | 6px: dense row padding; absorbs .35rem, .38rem and .4rem (154 declarations; .3rem, 78 more, snaps to --s-1) | `6px` | same | literal today; see the literal tables | - | 0 | - |
| DS-TOK-60 | `--s-2` | 8px | `0.5rem` → 8px | same | `hub-ds/spacing.css:15` | `--space-2` | 153 | 3 |
| DS-TOK-61 | `--s-3` | 12px: the default gap | `0.75rem` → 12px | same | `hub-ds/spacing.css:16` | `--space-3` | 347 | 9 |
| DS-TOK-62 | `--s-4` | 16px | `1rem` → 16px | same | `hub-ds/spacing.css:17` | `--space-4` | 252 | 6 |
| DS-TOK-63 | `--s-5` | 24px | `1.5rem` → 24px | same | `hub-ds/spacing.css:18` | `--space-5` | 136 | 6 |
| DS-TOK-64 | `--s-6` | 32px: content padding at desk widths | `2rem` → 32px | same | `hub-ds/spacing.css:19` | `--space-6` | 22 | - |
| DS-TOK-65 | `--s-7` | 48px | `3rem` → 48px | same | `hub-ds/spacing.css:20` | `--space-7` | 9 | 2 |
| DS-TOK-66 | `--s-8` | 64px | `4rem` → 64px | same | `hub-ds/spacing.css:21` | - | 1 | 1 |
| DS-TOK-67 | `--s-9` | 96px (used only by the client-portal monthly report) | `6rem` → 96px | same | `hub-ds/spacing.css:22` | - | 0 | 1 |
| DS-TOK-68 | `--pad-x` | clamp(20px, 3.2vw, 32px): page gutter | `0` → 32px | same | `hub-ds/spacing.css:25`, `hub-ds/buttons.css:44`, `hub-ds/buttons.css:93`, `hub-ds/buttons.css:109` +3 | `--pad-y` | 3 | - |

Drift, near-duplicates and defects:

- **DS-TOK-68 `--pad-x`** · --pad-y: clamp(64px, 8vw, 112px), Hub marketing, unused. Verdict: drop.
- **DS-TOK-68 `--pad-x`** · .btn --pad-x: buttons.css reuses the name as a component-local em value. Verdict: rename component-local (PRIMITIVES lane).

### Radii

Anatomy: one value. Variants kept: one (these tokens do not flip with the theme unless the Dark column says so). States: none.

| ID | Token | Purpose | Value (source → resolved at 1480) | Dark | Construction (`file:line` in dashboard-mockups/assets) | Aliases mapped here | CSS refs | Inventory ids |
|---|---|---|---|---|---|---|---|---|
| DS-TOK-69 | `--radius-none` | 0: every box. The system is square | `0` → 0px | same | `hub-ds/radius.css:13` | `--radius-xs`, `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius`, `--radius-xl` | 22 | - |
| DS-TOK-70 | `--radius-pill` | 999px: chips, counts, meter tracks, switches, pill buttons | `999px` | same | `hub-ds/radius.css:14` | - | 17 | - |
| DS-TOK-71 | `--radius-round` (proposed) | 50%: avatars and status dots; today literal 50% ×13 | `50%` | same | literal today; see the literal tables | - | 0 | - |

### Shadows and focus

Anatomy: one value. Variants kept: one (these tokens do not flip with the theme unless the Dark column says so). States: none.

| ID | Token | Purpose | Value (source → resolved at 1480) | Dark | Construction (`file:line` in dashboard-mockups/assets) | Aliases mapped here | CSS refs | Inventory ids |
|---|---|---|---|---|---|---|---|---|
| DS-TOK-72 | `--shadow-sm` | Cards and the floating dock rail | `0 1px 2px rgba(15, 18, 24, 0.05)` | `0 1px 2px rgba(0, 0, 0, 0.45)` → `0 1px 2px rgba(0, 0, 0, 0.45)` | `hub-ds/colors.css:134` (dark), `hub-ds/colors.css:172` (light re-assert), `hub-ds/radius.css:29` | - | 4 | 2 |
| DS-TOK-73 | `--shadow` | Raised menus and popovers | `0 1px 3px rgba(15, 18, 24, 0.08), 0 14px 32px -20px rgba(15, 18, 24, 0.24)` | `0 1px 3px rgba(0, 0, 0, 0.5), 0 18px 42px -24px rgba(0, 0, 0, 0.7)` → `0 1px 3px rgba(0, 0, 0, 0.5), 0 18px 42px -24px rgba(0, 0, 0, 0.7)` | `hub-ds/colors.css:135` (dark), `hub-ds/colors.css:173` (light re-assert), `hub-ds/radius.css:30` | `--shadow-2` | 2 | - |
| DS-TOK-74 | `--shadow-lg` | Large floating panels | `0 2px 8px rgba(15, 18, 24, 0.1), 0 24px 64px -30px rgba(15, 18, 24, 0.32)` | `0 2px 8px rgba(0, 0, 0, 0.5), 0 30px 80px -34px rgba(0, 0, 0, 0.85)` → `0 2px 8px rgba(0, 0, 0, 0.5), 0 30px 80px -34px rgba(0, 0, 0, 0.85)` | `hub-ds/colors.css:136` (dark), `hub-ds/colors.css:174` (light re-assert), `hub-ds/radius.css:31` | - | 4 | - |
| DS-TOK-75 | `--shadow-overlay` | Off-canvas drawer and the seated-dock lift | `0 24px 60px oklch(0 0 0 / 0.45)` | same | `hub-ds/radius.css:32` | - | 7 | 1 |
| DS-TOK-76 | `--shadow-edge` (proposed) | Sticky-column edge shade (app.css:4362, 10995) | `-10px 0 10px -10px color-mix(in srgb, var(--text) 30%, transparent)` | same | literal today; see the literal tables | - | 0 | - |
| DS-TOK-77 | `--focus-ring` | Keyboard focus: 2px ground gap then 2px accent | `0 0 0 2px var(--bg), 0 0 0 4px var(--accent)` → `0 0 0 2px oklch(1 0 0), 0 0 0 4px oklch(0.58 0.21 285)` | `0 0 0 2px var(--void), 0 0 0 4px var(--accent)` → `0 0 0 2px oklch(0.145 0.006 285), 0 0 0 4px oklch(0.58 0.21 285)` | `tokens.css:115` (dark), `hub-ds/radius.css:38` | `--focus` | 8 | 1 |

Drift, near-duplicates and defects:

- **DS-TOK-73 `--shadow`** · --shadow-2: undeclared; app.css:6335 falls back to 0 6px 20px ink 22%. Verdict: map to --shadow (defect: phantom token).
- **DS-TOK-77 `--focus-ring`** · tokens.css:115: dark redefines the gap as --void; same result as --bg. Verdict: drop the dark line.
- **DS-TOK-77 `--focus-ring`** · outline literals: `2px solid var(--accent)` ×2, `1px solid var(--accent)` ×2, `2px solid var(--focus, currentColor)` (app.css:10542, 12814, where --focus is undeclared). Verdict: map all to --focus-ring (defect: phantom --focus).

### Motion

Anatomy: one value. Variants kept: one (these tokens do not flip with the theme unless the Dark column says so). States: none.

| ID | Token | Purpose | Value (source → resolved at 1480) | Dark | Construction (`file:line` in dashboard-mockups/assets) | Aliases mapped here | CSS refs | Inventory ids |
|---|---|---|---|---|---|---|---|---|
| DS-TOK-78 | `--ease` | The one curve: cubic-bezier(0.16, 1, 0.3, 1), a fast-out settle | `cubic-bezier(0.16, 1, 0.3, 1)` | same | `hub-ds/radius.css:44` | `--ease-out` | 110 | 1 |
| DS-TOK-79 | `--dur-fast` | 120ms: hover, press, chevrons | `0.12s` | same | `hub-ds/radius.css:46` | - | 38 | - |
| DS-TOK-80 | `--dur` | 180ms: small state changes (hub-ds components) | `0.18s` | same | `hub-ds/radius.css:47` | - | 39 | - |
| DS-TOK-81 | `--dur-1` | 220ms: rail collapse, panel fades | `220ms` | same | `hub-ds/radius.css:49` | - | 36 | 1 |
| DS-TOK-82 | `--dur-2` | 420ms: the dock seat glide and other layout moves | `420ms` | same | `hub-ds/radius.css:50` | `--dur-slow`, `--dur-3` | 7 | 1 |
| DS-TOK-83 | `--dur-flash` (proposed) | The locate flash (`.flash-target`, app.css:1555) only. The 500ms theme and face shift in portal.js:141-147 is not this token: it uses DS-TOK-82 `--dur-2` (420ms, the nearest step; OP-22) | `1.5s` | same | literal today; see the literal tables | - | 0 | - |

Drift, near-duplicates and defects:

- **DS-TOK-78 `--ease`** · `ease` keyword: 16 declarations use the browser `ease` (for example `.chev` app.css:2937). Verdict: map to --ease.
- **DS-TOK-79 `--dur-fast`** · .15s: 10 declarations. Verdict: map to --dur-fast.
- **DS-TOK-79 `--dur-fast`** · 120ms: 3 literal repeats. Verdict: map to --dur-fast.
- **DS-TOK-81 `--dur-1`** · --dur: 40ms apart; both are used (39 and 36 references). Verdict: ruled by DR-15: keep both, `--dur` 180 for colour and `--dur-1` 220 for movement.
- **DS-TOK-82 `--dur-2`** · --dur-slow 280ms, --dur-3 820ms: declared, never used. Verdict: drop.

### Breakpoints

Anatomy: one value. Variants kept: one (these tokens do not flip with the theme unless the Dark column says so). States: none.

| ID | Token | Purpose | Value (source → resolved at 1480) | Dark | Construction (`file:line` in dashboard-mockups/assets) | Aliases mapped here | CSS refs | Inventory ids |
|---|---|---|---|---|---|---|---|---|
| DS-TOK-84 | `--bp-mobile` | 640px: phone | `640px` | same | `hub-ds/breakpoints.css:33` | - | 0 | - |
| DS-TOK-85 | `--bp-tablet` | 900px: the chrome line (rail goes off-canvas) | `900px` | same | `hub-ds/breakpoints.css:34` | - | 0 | - |
| DS-TOK-86 | `--bp-desk` | 1279px: sheet dock ends, page grids widen | `1279px` | same | `hub-ds/breakpoints.css:35` | - | 0 | - |
| DS-TOK-87 | `--bp-seat` (proposed) | 1440px: the dock may seat (dock.js matchMedia and the pre-paint hook) | `1440px` | same | literal today; see the literal tables | - | 0 | - |

Drift, near-duplicates and defects:

- **DS-TOK-87 `--bp-seat`** · 700, 760, 1180: page-local media queries (projectsboard.js, app.css:12903, 12907). Verdict: drop or move to container queries.

### Shell dimensions

Anatomy: one value. Variants kept: one (these tokens do not flip with the theme unless the Dark column says so). States: none.

| ID | Token | Purpose | Value (source → resolved at 1480) | Dark | Construction (`file:line` in dashboard-mockups/assets) | Aliases mapped here | CSS refs | Inventory ids |
|---|---|---|---|---|---|---|---|---|
| DS-TOK-88 | `--rail-w` | 224px default, drag-resizable; set by the pre-paint hook and portal.js:633 | `` | same |  | `--sidebar-w` | 8 | 1 |
| DS-TOK-89 | `--rail-w-collapsed` (proposed) | 56px collapsed rail; today a literal in the pre-paint hook (`route-home/index.html:18`, repeated in every shell page) and portal.js | `56px` | same | literal today; see the literal tables | `--sidebar-collapsed-w` | 0 | - |
| DS-TOK-90 | `--app-strip` | 45px: the app strip height above the page chrome | `45px` | same | `app.css:4761` (@media not all and (max-width: 900px)) | `--topbar-h` | 6 | - |
| DS-TOK-91 | `--dock-w` | Seated dock width, 0 when floating; default panel 550, minimum 380 (dock.js:315) | 0px | same |  | `--aip-dock` | 4 | - |
| DS-TOK-92 | `--content-floor` (proposed) | The main column never goes under 836px when the dock seats (WIRING §34.4); today a literal in the pre-paint hook | `836px` | same | literal today; see the literal tables | `--content-max` | 0 | - |

Drift, near-duplicates and defects:

- **DS-TOK-88 `--rail-w`** · --sidebar-w: DS declares 220px (hub-ds/radius.css:54), never used; the mockup measures 224. Verdict: drop --sidebar-w, keep 224 (SIDEBAR lane).
- **DS-TOK-89 `--rail-w-collapsed`** · --sidebar-collapsed-w: DS declares 58px, unused. Verdict: drop, keep 56.
- **DS-TOK-90 `--app-strip`** · --topbar-h: DS 58px, unused. Verdict: drop.
- **DS-TOK-91 `--dock-w`** · --aip-dock: 380px declared at app.css:1242, unused. Verdict: drop.
- **DS-TOK-92 `--content-floor`** · --content-max: 1360px, unused. Verdict: drop.

### Z-index layers

Anatomy: one value. Variants kept: one (these tokens do not flip with the theme unless the Dark column says so). States: none.

| ID | Token | Purpose | Value (source → resolved at 1480) | Dark | Construction (`file:line` in dashboard-mockups/assets) | Aliases mapped here | CSS refs | Inventory ids |
|---|---|---|---|---|---|---|---|---|
| DS-TOK-93 | `--z-raised` (proposed) | 1 to 5: stacking inside one component (grips 5, sort arrows 3, stages 2) | `1` | same | literal today; see the literal tables | - | 0 | - |
| DS-TOK-94 | `--z-sticky` (proposed) | 30: sticky topbar and chrome | `30` | same | literal today; see the literal tables | - | 0 | - |
| DS-TOK-95 | `--z-popover` (proposed) | 40: menus, date pops, the appbar | `40` | same | literal today; see the literal tables | - | 0 | - |
| DS-TOK-96 | `--z-dock-rail` (proposed) | 45: the dock rail | `45` | same | literal today; see the literal tables | - | 0 | - |
| DS-TOK-97 | `--z-backdrop` (proposed) | 55: the nav backdrop under the drawer | `55` | same | literal today; see the literal tables | - | 0 | - |
| DS-TOK-98 | `--z-nav` (proposed) | 60: the rail drawer and the agency dock | `60` | same | literal today; see the literal tables | - | 0 | - |
| DS-TOK-99 | `--z-chrome-lift` (proposed) | 65: the chrome over a seated dock (`body.ai-dock .chrome`) | `65` | same | literal today; see the literal tables | - | 0 | - |
| DS-TOK-100 | `--z-panel` (proposed) | 70: floating AI panel and small-width dock | `70` | same | literal today; see the literal tables | - | 0 | - |
| DS-TOK-101 | `--z-tooltip` (proposed) | 80: term tooltips and dock tab labels | `80` | same | literal today; see the literal tables | - | 0 | - |

Drift, near-duplicates and defects:

- **DS-TOK-94 `--z-sticky`** · 11, 12: board filter bars (app.css:11705, 11722). Verdict: keep local to the board.
- **DS-TOK-95 `--z-popover`** · 45: `.cbdta__menu`, `.cbd__menu` at 45. Verdict: map to --z-popover.
- **DS-TOK-100 `--z-panel`** · 72: `.sb` sidebar panel at 72. Verdict: not built: the fixed `.sb` rule is dead and no `.sb` layer exists (DR-19).

### Icon sizes

Anatomy: one value. Variants kept: one (these tokens do not flip with the theme unless the Dark column says so). States: none.

| ID | Token | Purpose | Value (source → resolved at 1480) | Dark | Construction (`file:line` in dashboard-mockups/assets) | Aliases mapped here | CSS refs | Inventory ids |
|---|---|---|---|---|---|---|---|---|
| DS-TOK-102 | `--icon-xs` (proposed) | Rail fold chevron (.52rem), tiny carets (.5rem, .55rem) | `8px` | same | literal today; see the literal tables | - | 0 | - |
| DS-TOK-103 | `--icon-sm` (proposed) | Inline UI icons: appbar back and forward, timer, search (.7rem to .8125rem) | `12px` | same | literal today; see the literal tables | - | 0 | - |
| DS-TOK-104 | `--icon-md` (proposed) | Dock tabs, collapsed rail icons (1rem; .875rem to 1.05rem snap here) | `16px` | same | literal today; see the literal tables | - | 0 | - |
| DS-TOK-105 | `--icon-lg` (proposed) | Empty-state and hero icons (1.5rem) | `24px` | same | literal today; see the literal tables | - | 0 | - |
| DS-TOK-106 | `--icon-door` (proposed) | Door marks: .85em of the host, 62% currentColor (WIRING §98) | `0.85em` | same | literal today; see the literal tables | - | 0 | - |

### Mock-data mark (added by the Astra cross-check)

R56 (decided, ticket #302) keeps the owner's pink wherever mock data shows, so the mark's three values are canonical tokens for demo installs. A real client has no mock data and never shows them. They sit outside the product's semantic palette and mix in `oklab`, not `oklch`. Used only by DS-PRIM-32.

| ID | Token | Purpose | Value (source → resolved at 1480) | Dark | Construction (`file:line` in dashboard-mockups/assets) | Aliases mapped here | CSS refs | Inventory ids |
|---|---|---|---|---|---|---|---|---|
| DS-TOK-130 | `--mock-pink` | The mock mark's hue; kept clear of the accent violet | `oklch(0.70 0.19 350)` | `oklch(0.78 0.20 358)` (hue shifted so it never reads as accent over the dark ground) | `app.css:10471`, `:10494` (dark) | - | 2 | WORKBENCH SH-26 |
| DS-TOK-131 | `--mock-tint` | The wash over a mock region | `color-mix(in oklab, var(--mock-pink) 9%, transparent)` | 20% | `app.css:10475`, `:10495` (dark) | - | 1 | WORKBENCH SH-26 |
| DS-TOK-132 | `--mock-edge` | The inset hairline that separates two marked regions | `color-mix(in oklab, var(--mock-pink) 34%, transparent)` | 48% | `app.css:10476`, `:10496` (dark) | - | 1 | WORKBENCH SH-26 |

### App-strip ink ladder (note, no new ids)

The app strip (`--app-chrome`, dark in both themes, teal on the client face) draws its own ink ladder from twelve `color-mix(in oklch, var(--app-ink) N%, transparent)` recipes at 7, 8, 10, 12, 20, 22, 30, 46, 50, 55, 60 and 70% (`app.css:2700-2746`). They mirror the page ladder on a dark ground. Decided: the SIDEBAR lane names four steps in its spec (`--app-ink` 100%, 70% for secondary, 50% for muted, 12% for lines) and the twelve recipes fold into those. Handed to SIDEBAR.

**Tokens no spec cites (AUDIT-RECONCILE, 27 September, OP-26).** 39 of the 132 tokens are cited by no component spec, text style, page map or register row: the z-index scale (DS-TOK-93 to DS-TOK-101, except 100), icon sizes (DS-TOK-102 to DS-TOK-106), breakpoints (DS-TOK-84 to DS-TOK-87), `--shadow`, `--shadow-lg`, `--scrim`, `--hover-accent` and ten text styles. The structural ones (z-index, icon sizes, breakpoints, shadows, scrim) stay: the build scaffolding uses them whether or not a spec names them. The ten text styles go to MP-1-4's census: each is cited from the component that uses it, or retired there.

## Canonical text styles

23 named styles replace 144. Each is a real custom property holding a `font` shorthand, with tracking and case beside it (the build can also expose them as `.t-*` classes). Sizes, weights, line heights and tracking reference the primitive tokens above.

| ID | Text style | Composition (family size/line-height weight tracking case) | `font` shorthand | Role | Census styles → nodes |
|---|---|---|---|---|---|
| DS-TOK-107 | `--type-display` | Display 44/1.1 500 -0.03em | `var(--weight-medium) var(--text-display)/var(--lh-title) var(--font-display)`; tracking `--tracking-display` | Hero names, verdict lines | 5 → 6 |
| DS-TOK-108 | `--type-section` | Display 28/1.1 500 -0.01em | `var(--weight-medium) var(--fs-title)/var(--lh-title) var(--font-display)`; tracking `--tracking-tight` | Section heads (`.sec__head`) | 1 → 27 |
| DS-TOK-109 | `--type-title` | Display 24/1.1 500 -0.01em | `var(--weight-medium) var(--text-h1)/var(--lh-title) var(--font-display)`; tracking `--tracking-tight` | Page title (`h1.t-title`, `.topbar__section`) | 4 → 20 |
| DS-TOK-110 | `--type-heading` | Display 20/1.1 500 -0.01em | `var(--weight-medium) var(--text-h2)/var(--lh-title) var(--font-display)`; tracking `--tracking-tight` | Panel and brief headings, wordmark | 4 → 11 |
| DS-TOK-111 | `--type-subheading` | Display 16/1.1 500 -0.01em | `var(--weight-medium) var(--text-h3)/var(--lh-title) var(--font-display)`; tracking `--tracking-tight` | Group heads, client header name | 4 → 16 |
| DS-TOK-112 | `--type-rail-label` | Display 13/1.1 500 0.02em UPPER | `var(--weight-medium) var(--text-sm)/var(--lh-title) var(--font-display)`; tracking `--tracking-label`; uppercase | Rail HUB label, client mark | 2 → 23 |
| DS-TOK-113 | `--type-num-lg` | Display 34/1 500 -0.03em | `var(--weight-medium) var(--text-num-lg)/var(--leading-none) var(--font-display)`; tracking `--tracking-display` | Stat numbers (`.stat__num`) | 2 → 27 |
| DS-TOK-114 | `--type-num-md` | Display 26/1 400 0.01em | `var(--weight-regular) var(--text-num-md)/var(--leading-none) var(--font-display)`; tracking `0.01em` (corrected by the Astra cross-check: the verdict value `.vrow__val` renders 400 with 0.26 px tracking, `app.css:792-795`) | Verdict values | 6 → 33 |
| DS-TOK-115 | `--type-num-sm` | Display 22/1 400 0.01em | `var(--weight-regular) var(--text-num-sm)/var(--leading-none) var(--font-display)`; tracking `0.01em` (corrected by the Astra cross-check: `.srcbox__val` renders 400 with 0.22 px tracking) | Source-box values | 3 → 6 |
| DS-TOK-116 | `--type-body-lg` | Sans 15/1.55 400 0em | `var(--weight-regular) var(--text-body-lg)/var(--leading-normal) var(--font-sans)`; tracking `0` | Lead body, AI claims | 10 → 36 |
| DS-TOK-117 | `--type-body` | Sans 14/1.55 400 0em | `var(--weight-regular) var(--text-body)/var(--leading-normal) var(--font-sans)`; tracking `0` | Body; idle rail items and tabs | 10 → 488 |
| DS-TOK-118 | `--type-body-strong` | Sans 14/1.55 500 0em | `var(--weight-medium) var(--text-body)/var(--leading-normal) var(--font-sans)`; tracking `0` | Emphasis, active rail item, active tab | 6 → 234 |
| DS-TOK-119 | `--type-card-title` | Sans 15/1.1 600 0em | `var(--weight-semibold) var(--text-body-lg)/var(--lh-title) var(--font-sans)`; tracking `0` | Card titles (`.card__title`) | 3 → 79 |
| DS-TOK-120 | `--type-small` | Sans 13/1.55 400 0em | `var(--weight-regular) var(--text-sm)/var(--leading-normal) var(--font-sans)`; tracking `0` | Secondary copy, card subs, appbar text | 16 → 513 |
| DS-TOK-121 | `--type-small-strong` | Sans 13/1.55 500 0em | `var(--weight-medium) var(--text-sm)/var(--leading-normal) var(--font-sans)`; tracking `0` | Row titles, strong secondary | 8 → 81 |
| DS-TOK-122 | `--type-caption` | Sans 12/1.55 400 0em | `var(--weight-regular) var(--text-label)/var(--leading-normal) var(--font-sans)`; tracking `0` | Table subs, citations | 9 → 180 |
| DS-TOK-123 | `--type-button` | Sans 12/1 500 -0.01em | `var(--weight-medium) var(--text-label)/var(--leading-none) var(--font-sans)`; tracking `--tracking-tight` | Button labels (`.btn--sm`; `.btn` 13 and `.btn--lg` 15 are size variants) | 2 → 74 |
| DS-TOK-124 | `--type-data` | Mono 12/1.55 400 0em | `var(--weight-regular) var(--text-label)/var(--leading-normal) var(--font-mono)`; tracking `0` | Table cells, dates, figures | 13 → 674 |
| DS-TOK-125 | `--type-mono` | Mono 14/1.55 400 0em | `var(--weight-regular) var(--text-body)/var(--leading-normal) var(--font-mono)`; tracking `0` | Code, larger mono figures | 3 → 29 |
| DS-TOK-126 | `--type-eyebrow` | Mono 12/1.4 300 0.02em UPPER | `var(--weight-light) var(--text-label)/var(--lh-body) var(--font-mono)`; tracking `--tracking-label`; uppercase | Eyebrows, stat labels, segmented buttons | 9 → 375 |
| DS-TOK-127 | `--type-tag` | Mono 14/1.55 300 0.02em UPPER | `var(--weight-light) var(--text-body)/var(--leading-normal) var(--font-mono)`; tracking `--tracking-label`; uppercase | `.marker.u-tag` | 2 → 177 |
| DS-TOK-128 | `--type-chip` | Mono 11/1 400 0.06em UPPER | `var(--weight-regular) var(--text-overline)/var(--leading-none) var(--font-mono)`; tracking `--tracking-caps`; uppercase | Chips, keycaps, stamps | 5 → 143 |
| DS-TOK-129 | `--type-badge` | Mono 10/1 400 0em | `var(--weight-regular) var(--text-micro)/var(--leading-none) var(--font-mono)`; tracking `0` | Counts and badges | 7 → 198 |

Drift, near-duplicates and defects:

- **Faux bold.** `<strong>` and `<b>` compute weight 700 (88 nodes). No 700 face is loaded for Funnel Sans or Chivo Mono (`tokens.css:29` loads Sans 400 to 600 and Mono 300 to 500), so Sans falls back to 600 and Mono is synthesised. Defect, not to copy: strong maps to --weight-medium in body text.
- **em stacking.** Sizes such as 13.12, 12.48, 10.88, 10.24 and 9.92 are `em` values multiplying 14px or 13px parents. They all snap to the nearest step. Defect, not to copy: text sizes in the build reference tokens, never `em`.
- **Section head bigger than page title.** `.sec__head` is 28px (--fs-title at 1480) while `h1.t-title` is 24px. Ruled by DR-12: keep, as drawn.
- **Display type set in Sans.** Five styles draw headline or number roles in Funnel Sans (`.nr__h` 36, `.brief__headline` 25.6, `.cread__v` 24, `.big` 22.4, `.num` 19.2). Ruled by DR-6: all five move to Display (TICKET-PLAN R53); the task run hero's mono 20 numbers stay a named style (`TASK-PAGE.md` DS-TASK-4).
- **Hero outsizes.** `.hero__num` 128/0.85 and `.hero__name` 49.6 exceed --text-display (44). Ruled by DR-7: hero-only exceptions owned by DS-COMP-31.
- **Browser monospace** on `code` (5 routes): maps to --type-mono.

### Type census: every measured style mapped

Method: every visible element with its own text node, on 17 routes at 1480 in light (the ten SHELL routes `/dashboard/`, `/projects/`, `/clients/`, `/connections/`, `/connections/site-health/`, `/clients/meridian-dental/` (the mockup's sample client), `…/reports/weekly/`, `…/workbench/google-ads/`, `…/library/brand/`, `/portal/meridian-dental/`, plus `/agency/task/?task=proj-verity-pacing`, `/agency/task/?task=proj-website-rebuild` (a missing-task state), `/inbox/`, `/docs/`, `/settings/`, `/projects/reviews/`, `/clients/meridian-dental/projects/`). Key: family (D Display, S Sans, M Mono), size px / line height as a ratio, weight, tracking in em, U for uppercase. SHELL section 1.2 counted 112 styles in 2,085 nodes on its ten routes. On the same ten routes this pass counts 131 styles in 3,126 nodes: it takes every rendered element that owns a text node, including inline `b`, `strong`, `span` and SVG text inside larger blocks, so the 112 are a subset of this census up to method. The seven extra routes bring the total to 144. SHELL's named styles DS-T1 to DS-T17 are mapped one by one in the old-id table at the end. The mapping is by rule (`lane-scratch/TOKENS/typemap.mjs`): glyph selectors become icons; otherwise family, size band, weight and case pick the style. "Verdict" is `exact` when every attribute matches, `drift, drop` when all differences are within tolerance (size within 2 px), and `could be deliberate` when the family, case or size differs by more.

**How the rulings apply to the census** (added at build-ready, 27 September 2026). A `could be deliberate` row, here and in the colour census below, is a measurement label, not an open question. Every one is ruled: under TICKET-PLAN R53 each text row snaps to the canonical style in its row, except the named exceptions, which are the portal hero's `hero__num` and `hero__name` (DR-7, owned by DS-COMP-31) and the task run hero's mono 20 numbers (DR-6, `TASK-PAGE.md` DS-TASK-4); the five Funnel Sans number and headline roles (`nr__h`, `brief__headline`, `cread__v`, `big`, `num`) move to Display (DR-6); the 15 px button label is DS-PRIM-1 `--lg`, not drift. A colour row marked "map or keep as a tint" maps to the nearest token it names (no duplicates, DIRECTION point 1).

| # | Measured style | Nodes | Routes | Sample selectors | → Canonical | Differences | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | `M 12/1.55 400 0` | 540 | 10 | `up-ms` `approval__meta` `span` | DS-TOK-124 `--type-data` | - | exact |
| 2 | `S 14/1.55 400 0` | 406 | 17 | `span` `up-pct` `div` | DS-TOK-117 `--type-body` | - | exact |
| 3 | `S 13/1.55 400 0` | 302 | 17 | `card__sub` `span` `t-sm` | DS-TOK-120 `--type-small` | - | exact |
| 4 | `S 14/1.55 500 0` | 178 | 17 | `b` `span` `cbd__nm` | DS-TOK-118 `--type-body-strong` | - | exact |
| 5 | `M 14/1.55 300 0.02 U` | 150 | 10 | `marker` `num` `chlink` | DS-TOK-127 `--type-tag` | - | exact |
| 6 | `M 12/1.4 300 0.02 U` | 134 | 8 | `span` `srcline__ratio` `vrow__src` | DS-TOK-126 `--type-eyebrow` | - | exact |
| 7 | `M 11/1 400 0.06 U` | 112 | 13 | `chip` | DS-TOK-128 `--type-chip` | - | exact |
| 8 | `M 12/1.55 400 0.02 U` | 106 | 9 | `cls` `span` `conn__auth` | DS-TOK-126 `--type-eyebrow` | weight 400→300; lh 1.55→1.4 | drift, drop |
| 9 | `S 11/1.55 400 0` | 85 | 5 | `cbd__chip` `cbd__more` `skc__say` | DS-TOK-122 `--type-caption` | size 11→12 | drift, drop |
| 10 | `M 12/1.55 300 0.02 U` | 76 | 15 | `button` `r` `th` | DS-TOK-126 `--type-eyebrow` | lh 1.55→1.4 | drift, drop |
| 11 | `S 15/1.2 600 0` | 74 | 12 | `card__title` | DS-TOK-119 `--type-card-title` | - | exact |
| 12 | `S 12/1 500 -0.01` | 73 | 10 | `btn` `span` | DS-TOK-123 `--type-button` | - | exact |
| 13 | `M 10.24/1 400 0` | 64 | 1 | `shb` | DS-TOK-129 `--type-badge` | size 10.24→10 | drift, drop |
| 14 | `S 12/1.55 400 0` | 59 | 6 | `table__sub` `nr__cite` `muted` | DS-TOK-122 `--type-caption` | - | exact |
| 15 | `M 12/1.55 400 0.02` | 49 | 1 | `skc__k` `tw__k` `skc__iok` | DS-TOK-124 `--type-data` | tracking 0.02→0em | drift, drop |
| 16 | `M 10/1.55 400 0` | 46 | 2 | `text` | DS-TOK-129 `--type-badge` | lh 1.55→1 | drift, drop |
| 17 | `S 13/1.4 400 0` | 43 | 6 | `psr__fdetail` `stg__say` `kv` | DS-TOK-120 `--type-small` | lh 1.4→1.55 | drift, drop |
| 18 | `S 14/1.55 700 0` | 41 | 13 | `strong` | DS-TOK-118 `--type-body-strong` | weight 700→500 | drift, drop |
| 19 | `S 13/1.55 500 0` | 38 | 4 | `t-sm` `psr__ftitle` `gantt__name` | DS-TOK-121 `--type-small-strong` | - | exact |
| 20 | `S 13.12/1.55 400 0` | 37 | 2 | `muted` `lbl` `facet` | DS-TOK-120 `--type-small` | size 13.12→13 | drift, drop |
| 21 | `M 10/1 400 0` | 35 | 16 | `cbadge` `dock__n` | DS-TOK-129 `--type-badge` | - | exact |
| 22 | `S 11.2/1 400 0` | 31 | 3 | `sbbox__tick` | DS-TOK-103 `--icon-sm` | glyph text, sized as an icon | icon |
| 23 | `S 16.8/1 400 0` | 31 | 8 | `banner__x` `ps__x` | DS-TOK-104 `--icon-md` | glyph text, sized as an icon | icon |
| 24 | `M 12/1.5 300 0.02 U` | 29 | 5 | `stat__label` `term` `rec__label` | DS-TOK-126 `--type-eyebrow` | lh 1.5→1.4 | drift, drop |
| 25 | `S 13/1.55 400 0.01` | 29 | 6 | `num` `t-sm` `is-ok` | DS-TOK-120 `--type-small` | tracking 0.01→0em | drift, drop |
| 26 | `S 14/1.55 400 0.01` | 28 | 3 | `num` `loop__age` | DS-TOK-117 `--type-body` | tracking 0.01→0em | drift, drop |
| 27 | `D 28/1.1 500 -0.01` | 27 | 8 | `sec__head` | DS-TOK-108 `--type-section` | - | exact |
| 28 | `M 8/1 400 0` | 27 | 1 | `cbadge` | DS-TOK-129 `--type-badge` | size 8→10 | drift, drop |
| 29 | `M 14/1.4 300 0.02 U` | 27 | 8 | `chlink` `marker` `u-mono` | DS-TOK-127 `--type-tag` | lh 1.4→1.55 | drift, drop |
| 30 | `S 13/1.5 400 0` | 27 | 2 | `nr__say` `grl__why` `tw__why` | DS-TOK-120 `--type-small` | - | exact |
| 31 | `D 34/1 500 -0.03` | 26 | 4 | `stat__num` | DS-TOK-113 `--type-num-lg` | - | exact |
| 32 | `S 13/1.55 700 0` | 24 | 1 | `b` `tw__what` | DS-TOK-121 `--type-small-strong` | weight 700→500 | drift, drop |
| 33 | `M 11.2/1.55 300 0.021 U` | 23 | 2 | `arrow` | DS-TOK-103 `--icon-sm` | glyph text, sized as an icon | icon |
| 34 | `S 13/1.35 400 0` | 20 | 3 | `cbd__presetw` | DS-TOK-120 `--type-small` | lh 1.35→1.55 | drift, drop |
| 35 | `S 14/1.4 400 0` | 18 | 5 | `vrow__verdict` `p` `a` | DS-TOK-117 `--type-body` | lh 1.4→1.55 | drift, drop |
| 36 | `M 12/1.55 400 0.01` | 18 | 2 | `num` | DS-TOK-124 `--type-data` | tracking 0.01→0em | drift, drop |
| 37 | `S 12.48/1.55 400 0` | 18 | 3 | `cl` `muted` | DS-TOK-120 `--type-small` | size 12.48→13 | drift, drop |
| 38 | `D 13/1.1 500 0.02 U` | 17 | 17 | `rail__hub` | DS-TOK-112 `--type-rail-label` | - | exact |
| 39 | `M 10.88/1.4 300 0.02 U` | 17 | 17 | `appbar__kbd` | DS-TOK-128 `--type-chip` | size 10.88→11; weight 300→400; lh 1.4→1; tracking 0.02→0.06em | drift, drop |
| 40 | `D 26/1 400 0.01` | 17 | 5 | `vrow__val` | DS-TOK-114 `--type-num-md` | none (this is the style's source; weight and tracking corrected 27 Sep) | canonical |
| 41 | `M 12/1 400 0.02 U` | 16 | 3 | `cbd__thl` | DS-TOK-126 `--type-eyebrow` | weight 400→300; lh 1→1.4 | drift, drop |
| 42 | `M 10/1.55 600 0` | 16 | 3 | `cbd__av` | DS-TOK-129 `--type-badge` | weight 600→400; lh 1.55→1 | drift, drop |
| 43 | `M 7.8/1 400 0` | 16 | 4 | `delta__caret` | DS-TOK-102 `--icon-xs` | glyph text, sized as an icon | icon |
| 44 | `M 14/1.55 400 0.01` | 14 | 1 | `num` | DS-TOK-125 `--type-mono` | tracking 0.01→0em | drift, drop |
| 45 | `S 11.2/1.55 400 0` | 13 | 4 | `layer__chev` | DS-TOK-103 `--icon-sm` | glyph text, sized as an icon | icon |
| 46 | `M 13/1.55 400 0` | 12 | 5 | `skc__n` `sb__addr` `mmeta__link` | DS-TOK-124 `--type-data` | size 13→12 | drift, drop |
| 47 | `S 16/1.45 400 0` | 12 | 1 | `swot__t` | DS-TOK-116 `--type-body-lg` | size 16→15 | drift, drop |
| 48 | `S 12.8/1.6 400 0` | 12 | 1 | `swot__go` | DS-TOK-120 `--type-small` | size 12.8→13 | drift, drop |
| 49 | `S 11/1.55 400 0.01` | 12 | 2 | `num` | DS-TOK-122 `--type-caption` | size 11→12; tracking 0.01→0em | drift, drop |
| 50 | `D 24/1.15 500 -0.01` | 11 | 11 | `t-title` | DS-TOK-109 `--type-title` | - | exact |
| 51 | `S 14.4/1.55 500 0` | 11 | 2 | `b` `mcal__month` | DS-TOK-118 `--type-body-strong` | size 14.4→14 | drift, drop |
| 52 | `S 14/1.5 400 0` | 11 | 2 | `a` `li` `rec__text` | DS-TOK-117 `--type-body` | - | exact |
| 53 | `monospace 14/1.55 400 0` | 10 | 5 | `code` | DS-TOK-125 `--type-mono` | family browser monospace→M | drift, drop |
| 54 | `M 10.88/1.55 300 0.02 U` | 10 | 10 | `marker` | DS-TOK-128 `--type-chip` | size 10.88→11; weight 300→400; lh 1.55→1; tracking 0.02→0.06em | drift, drop |
| 55 | `S 14.4/1.55 400 0.01` | 10 | 1 | `num` | DS-TOK-117 `--type-body` | size 14.4→14; tracking 0.01→0em | drift, drop |
| 56 | `M 14.4/1.55 400 0` | 10 | 1 | `chev` | DS-TOK-104 `--icon-md` | glyph text, sized as an icon | icon |
| 57 | `M 12/1.55 600 0` | 9 | 1 | `grl__agent` `tw__n` `b` | DS-TOK-124 `--type-data` | weight 600→400 | drift, drop |
| 58 | `M 12/1.4 400 0` | 9 | 2 | `psr__fage` `brief__date` | DS-TOK-124 `--type-data` | lh 1.4→1.55 | drift, drop |
| 59 | `M 12/1.55 500 0` | 8 | 3 | `tl__due` `up-ms` | DS-TOK-124 `--type-data` | weight 500→400 | drift, drop |
| 60 | `S 12/1.45 400 0` | 8 | 1 | `nr__adetail` `grl__bsay` | DS-TOK-122 `--type-caption` | - | exact |
| 61 | `S 16/1 400 0` | 8 | 2 | `mcal__num` `alert__chev` | DS-TOK-116 `--type-body-lg` | size 16→15; lh 1→1.45 | drift, drop |
| 62 | `M 9.92/1.55 400 0` | 8 | 1 | `span` | DS-TOK-129 `--type-badge` | size 9.92→10; lh 1.55→1 | drift, drop |
| 63 | `D 16.8/1.55 500 0` | 7 | 2 | `cbd__grpb` | DS-TOK-111 `--type-subheading` | size 16.8→16; lh 1.55→1.25; tracking 0→-0.01em | drift, drop |
| 64 | `M 12/1 500 -0.085` | 7 | 2 | `stat__of` | DS-TOK-124 `--type-data` | weight 500→400; lh 1→1.55; tracking -0.085→0em | drift, drop |
| 65 | `M 12/1.55 700 0` | 7 | 2 | `b` | DS-TOK-124 `--type-data` | weight 700→400 | drift, drop |
| 66 | `S 13.44/1.55 400 0` | 7 | 1 | `note` | DS-TOK-120 `--type-small` | size 13.44→13 | drift, drop |
| 67 | `D 18/1.1 400 0` | 6 | 5 | `vstrip__headline` `adet__t` | DS-TOK-110 `--type-heading` | size 18→20; weight 400→500; lh 1.1→1.25; tracking 0→-0.01em | drift, drop |
| 68 | `M 11.2/1.55 400 0.021 U` | 6 | 1 | `arrow` | DS-TOK-103 `--icon-sm` | glyph text, sized as an icon | icon |
| 69 | `M 12/1.4 400 0.02 U` | 6 | 3 | `swot__lab` `u-mono` | DS-TOK-126 `--type-eyebrow` | weight 400→300 | drift, drop |
| 70 | `M 13.12/1.55 400 0.01` | 6 | 1 | `num` | DS-TOK-124 `--type-data` | size 13.12→12; tracking 0.01→0em | drift, drop |
| 71 | `D 12/1.55 600 0` | 6 | 6 | `clienthdr__mark` | DS-TOK-112 `--type-rail-label` | size 12→13; weight 600→500; lh 1.55→1.1; tracking 0→0.02em; case none→UPPER | could be deliberate |
| 72 | `D 14.4/1.1 600 -0.01` | 6 | 6 | `clienthdr__name` | DS-TOK-111 `--type-subheading` | size 14.4→16; weight 600→500; lh 1.1→1.25 | drift, drop |
| 73 | `D 24/1.2 500 -0.01` | 6 | 6 | `topbar__section` | DS-TOK-109 `--type-title` | - | exact |
| 74 | `S 12.8/1.55 500 0` | 6 | 1 | `name` | DS-TOK-121 `--type-small-strong` | size 12.8→13 | drift, drop |
| 75 | `M 12/1.4 300 0.04 U` | 6 | 1 | `mstrip__k` `mcalc__src` | DS-TOK-126 `--type-eyebrow` | tracking 0.04→0.02em | drift, drop |
| 76 | `M 12/1.5 400 0` | 5 | 3 | `ai__basis` `kbatch__absent` | DS-TOK-124 `--type-data` | - | exact |
| 77 | `M 14/1.55 400 0` | 5 | 1 | `chan__mark` | DS-TOK-125 `--type-mono` | - | exact |
| 78 | `S 14/1.35 400 0` | 5 | 1 | `sbtask__t` | DS-TOK-117 `--type-body` | lh 1.35→1.55 | drift, drop |
| 79 | `S 15/1.45 400 0` | 4 | 3 | `ai__claim` | DS-TOK-116 `--type-body-lg` | - | exact |
| 80 | `D 22/1.55 400 0.01` | 4 | 4 | `srcbox__val` | DS-TOK-115 `--type-num-sm` | lh 1.55→1 (weight and tracking are the style's, corrected 27 Sep) | drift, drop |
| 81 | `D 26/1.55 500 0` | 4 | 1 | `text` | DS-TOK-114 `--type-num-md` | lh 1.55→1; weight 500→400; tracking 0→0.01em | drift, drop |
| 82 | `S 12/1.3 400 0` | 4 | 1 | `askbox__s` | DS-TOK-122 `--type-caption` | lh 1.3→1.5 | drift, drop |
| 83 | `D 27.2/1 500 0` | 4 | 1 | `n` | DS-TOK-114 `--type-num-md` | size 27.2→26; weight 500→400; tracking 0→0.01em | drift, drop |
| 84 | `S 14/1.7 400 0` | 4 | 1 | `li` | DS-TOK-117 `--type-body` | lh 1.7→1.55 | drift, drop |
| 85 | `S 12/1.5 600 0` | 4 | 1 | `b` | DS-TOK-122 `--type-caption` | weight 600→400 | drift, drop |
| 86 | `S 15/1.45 600 0` | 3 | 3 | `strong` | DS-TOK-119 `--type-card-title` | lh 1.45→1.2 | drift, drop |
| 87 | `S 14.4/1.5 400 0` | 3 | 3 | `li` | DS-TOK-117 `--type-body` | size 14.4→14 | drift, drop |
| 88 | `M 26/1.55 700 0` | 3 | 1 | `b` | DS-TOK-114 `--type-num-md` | family M→D; weight 700→400; lh 1.55→1; tracking 0→0.01em | could be deliberate |
| 89 | `S 18/1.55 400 0` | 3 | 1 | `grl__count` `tw__count` `nr__ran` | DS-TOK-116 `--type-body-lg` | size 18→15; lh 1.55→1.45 | could be deliberate |
| 90 | `S 12/1.55 700 0` | 3 | 1 | `b` | DS-TOK-122 `--type-caption` | weight 700→400 | drift, drop |
| 91 | `M 18/1.55 700 0` | 3 | 1 | `b` | DS-TOK-114 `--type-num-md` | family M→D; size 18→26; weight 700→400; lh 1.55→1; tracking 0→0.01em | could be deliberate |
| 92 | `S 13.76/1.55 400 0` | 3 | 1 | `srv__note` | DS-TOK-120 `--type-small` | size 13.76→13 | drift, drop |
| 93 | `S 17/1.55 500 0` | 3 | 2 | `mcal__kind` `mcal__when` | DS-TOK-116 `--type-body-lg` | size 17→15; weight 500→400; lh 1.55→1.45 | drift, drop |
| 94 | `S 13/1.4 700 0` | 3 | 2 | `strong` | DS-TOK-121 `--type-small-strong` | weight 700→500; lh 1.4→1.55 | drift, drop |
| 95 | `S 13.12/1.55 500 0` | 3 | 1 | `logo-v__name` | DS-TOK-121 `--type-small-strong` | size 13.12→13 | drift, drop |
| 96 | `S 13/1.45 400 0` | 3 | 1 | `tt__note` | DS-TOK-120 `--type-small` | lh 1.45→1.55 | drift, drop |
| 97 | `S 13/1.23 500 0` | 3 | 1 | `b` | DS-TOK-121 `--type-small-strong` | lh 1.23→1.55 | drift, drop |
| 98 | `S 12/1.33 400 0` | 3 | 1 | `msg__at` | DS-TOK-122 `--type-caption` | lh 1.33→1.5 | drift, drop |
| 99 | `S 13/1.23 400 0` | 3 | 1 | `sbint` | DS-TOK-120 `--type-small` | lh 1.23→1.55 | drift, drop |
| 100 | `S 13.6/1.45 400 0` | 3 | 1 | `msg__text` | DS-TOK-120 `--type-small` | size 13.6→13; lh 1.45→1.55 | drift, drop |
| 101 | `S 13.6/1.4 400 0` | 3 | 1 | `sbact__t` | DS-TOK-120 `--type-small` | size 13.6→13; lh 1.4→1.55 | drift, drop |
| 102 | `S 13/1.35 500 0` | 2 | 2 | `cbd__modew` | DS-TOK-121 `--type-small-strong` | lh 1.35→1.55 | drift, drop |
| 103 | `M 10/1 500 0` | 2 | 2 | `cbadge` | DS-TOK-129 `--type-badge` | weight 500→400 | drift, drop |
| 104 | `S 12.8/1 700 0` | 2 | 2 | `cbd__arrow` | DS-TOK-103 `--icon-sm` | glyph text, sized as an icon | icon |
| 105 | `D 12.5/1.55 500 0` | 2 | 2 | `cbd__grpr` | DS-TOK-111 `--type-subheading` | size 12.5→16; lh 1.55→1.25; tracking 0→-0.01em | could be deliberate |
| 106 | `S 12/1.5 400 0` | 2 | 2 | `tw__blocked` `mcalc` | DS-TOK-122 `--type-caption` | - | exact |
| 107 | `S 14.4/1.2 400 0` | 2 | 1 | `sel__lab` | DS-TOK-117 `--type-body` | size 14.4→14; lh 1.2→1.55 | drift, drop |
| 108 | `D 24/1.04 600 -0.062` | 2 | 2 | `hero__mark` | DS-TOK-109 `--type-title` | weight 600→500; lh 1.04→1.15; tracking -0.062→-0.01em | drift, drop |
| 109 | `D 49.6/1.04 500 -0.03` | 2 | 2 | `hero__name` | DS-TOK-107 `--type-display` | size 49.6→44; lh 1.04→1.1 | could be deliberate |
| 110 | `S 16.8/1.5 400 0` | 2 | 2 | `hero__sub` | DS-TOK-116 `--type-body-lg` | size 16.8→15 | drift, drop |
| 111 | `S 15/1.2 500 0` | 2 | 2 | `mtitle__who` | DS-TOK-119 `--type-card-title` | weight 500→600 | drift, drop |
| 112 | `S 24/1 500 0.01` | 2 | 1 | `cread__v` | DS-TOK-114 `--type-num-md` | family S→D; size 24→26; weight 500→400 | could be deliberate |
| 113 | `M 12/1.55 400 0  i` | 2 | 1 | `gantt__due` | DS-TOK-124 `--type-data` | - | exact |
| 114 | `M 11/1.55 400 0.02 U` | 2 | 2 | `stamp` | DS-TOK-128 `--type-chip` | lh 1.55→1; tracking 0.02→0.06em | drift, drop |
| 115 | `M 11/1.55 400 0` | 2 | 1 | `muted` | DS-TOK-124 `--type-data` | size 11→12 | drift, drop |
| 116 | `S 14/1.5 600 0` | 2 | 1 | `strong` | DS-TOK-118 `--type-body-strong` | weight 600→500 | drift, drop |
| 117 | `S 13/1.4 500 0` | 2 | 1 | `prior__out` `strong` | DS-TOK-121 `--type-small-strong` | lh 1.4→1.55 | drift, drop |
| 118 | `S 13/1.55 400 0  i` | 2 | 1 | `em` | DS-TOK-120 `--type-small` | - | exact |
| 119 | `D 20.8/1.55 600 -0.01` | 2 | 1 | `m` | DS-TOK-110 `--type-heading` | size 20.8→20; weight 600→500; lh 1.55→1.25 | drift, drop |
| 120 | `D 20.8/1.55 500 -0.01` | 2 | 1 | `wordmark` | DS-TOK-110 `--type-heading` | size 20.8→20; lh 1.55→1.25 | drift, drop |
| 121 | `M 10/1.55 500 0.02 U` | 2 | 1 | `stg__pri` | DS-TOK-128 `--type-chip` | size 10→11; weight 500→400; lh 1.55→1; tracking 0.02→0.06em | drift, drop |
| 122 | `S 12.5/1.55 400 0` | 1 | 1 | `cbd__read` | DS-TOK-120 `--type-small` | size 12.5→13 | drift, drop |
| 123 | `S 36/1.15 600 0` | 1 | 1 | `nr__h` | DS-TOK-107 `--type-display` | family S→D; weight 600→500; tracking 0→-0.03em | could be deliberate |
| 124 | `S 12/1.55 400 0.02 U` | 1 | 1 | `gradbar__l` | DS-TOK-126 `--type-eyebrow` | family S→M; weight 400→300; lh 1.55→1.4 | could be deliberate |
| 125 | `S 17/1.55 500 0.01` | 1 | 1 | `mbrief__when` | DS-TOK-116 `--type-body-lg` | size 17→15; weight 500→400; lh 1.55→1.45; tracking 0.01→0em | drift, drop |
| 126 | `S 25.6/1.15 500 -0.01` | 1 | 1 | `brief__headline` | DS-TOK-109 `--type-title` | family S→D; size 25.6→24 | could be deliberate |
| 127 | `M 16/1 400 0.015 U` | 1 | 1 | `brief__longchev` | DS-TOK-104 `--icon-md` | glyph text, sized as an icon | icon |
| 128 | `S 14/1.4 700 0` | 1 | 1 | `strong` | DS-TOK-118 `--type-body-strong` | weight 700→500; lh 1.4→1.55 | drift, drop |
| 129 | `D 14.28/1 500 -0.071` | 1 | 1 | `stat__suffix` | DS-TOK-111 `--type-subheading` | size 14.28→16; lh 1→1.25; tracking -0.071→-0.01em | drift, drop |
| 130 | `S 14/1.55 700 0.01` | 1 | 1 | `strong` | DS-TOK-118 `--type-body-strong` | weight 700→500; tracking 0.01→0em | drift, drop |
| 131 | `D 34/1.15 500 -0.01` | 1 | 1 | `verdict__line` | DS-TOK-107 `--type-display` | tracking -0.01→-0.03em | drift, drop |
| 132 | `D 128/0.85 500 -0.03` | 1 | 1 | `hero__num` | DS-TOK-107 `--type-display` | size 128→44; lh 0.85→1.1 | could be deliberate |
| 133 | `D 18/1.25 500 -0.01` | 1 | 1 | `rec__title` | DS-TOK-110 `--type-heading` | size 18→20 | drift, drop |
| 134 | `D 32/1.55 600 0` | 1 | 1 | `iconmark` | DS-TOK-105 `--icon-lg` | glyph text, sized as an icon | icon |
| 135 | `D 32/1 500 -0.01` | 1 | 1 | `big` | DS-TOK-113 `--type-num-lg` | size 32→34; tracking -0.01→-0.03em | drift, drop |
| 136 | `S 22.4/1 500 -0.01` | 1 | 1 | `big` | DS-TOK-115 `--type-num-sm` | family S→D; size 22.4→22; tracking -0.01→0.01em; weight 500→400 | could be deliberate |
| 137 | `S 15/1.55 400 0` | 1 | 1 | `recap__say` | DS-TOK-116 `--type-body-lg` | lh 1.55→1.45 | drift, drop |
| 138 | `S 16/1 500 0` | 1 | 1 | `mcal__num` | DS-TOK-116 `--type-body-lg` | size 16→15; weight 500→400; lh 1→1.45 | drift, drop |
| 139 | `S 17/1.55 400 0.01` | 1 | 1 | `mcal__time` | DS-TOK-116 `--type-body-lg` | size 17→15; lh 1.55→1.45; tracking 0.01→0em | drift, drop |
| 140 | `S 15/1 500 -0.01` | 1 | 1 | `btn` | DS-TOK-123 `--type-button` | size 15→12 | could be deliberate |
| 141 | `S 19.2/1.55 400 0.01` | 1 | 1 | `num` | DS-TOK-115 `--type-num-sm` | family S→D; size 19.2→22; lh 1.55→1 | could be deliberate |
| 142 | `D 44/1.15 600 -0.01` | 1 | 1 | `tpr__title` | DS-TOK-107 `--type-display` | weight 600→500; tracking -0.01→-0.03em | drift, drop |
| 143 | `M 13/1.4 300 0.02 U` | 1 | 1 | `mstrip__v` | DS-TOK-126 `--type-eyebrow` | size 13→12 | drift, drop |
| 144 | `S 14/1.6 400 0` | 1 | 1 | `p` | DS-TOK-117 `--type-body` | - | exact |

## Duplicates and literals

### Colour-mix recipes

77 uses of 51 distinct `color-mix()` recipes in `app.css`, plus the five literal colours in `app.css` and `hub-ds`. Each is resolved in both themes, composited over `--bg`, and matched to the nearest canonical colour by ΔE00.

| Recipe (`color-mix(in …)`) | Uses | Light over --bg → nearest | ΔE00 | Dark over --bg → nearest | ΔE00 | Verdict |
|---|---|---|---|---|---|---|
| `color-mix(in oklch, var(--ink) 12%, transparent)` | 4 (:2988, :5208) | #e0e0e0 --border | 0 | #262629 --app-chrome | 1.43 | → DS-TOK-10 `--border` (near-duplicate in both themes; dark ΔE00 1.58) |
| `color-mix(in oklch, var(--ink) 8%, transparent)` | 3 (:63, :829) | #ebebeb --surface-2 | 1.47 | #1c1c1e --surface-3 | 0.96 | light matches DS-TOK-3 `--surface-2`, dark is ΔE00 2.11 from it (nearest dark: --surface-3): map or keep as a tint (could be deliberate) |
| `color-mix(in oklab, var(--ink) 6%, var(--paper))` | 3 (:6314, :6385) | #ebebeb --surface-2 | 1.47 | #151517 --surface-2 | 1.25 | → DS-TOK-3 `--surface-2` (near-duplicate in both themes; dark ΔE00 1.25) |
| `color-mix(in oklch, var(--accent) 14%, transparent)` | 2 (:383, :1366) | #ebe8fd --surface-3 | 9.65 | #18152d --surface-2 | 11.76 | → DS-TOK-26 `--accent-wash` |
| `color-mix(in oklch, var(--accent) 6%, transparent)` | 2 (:406, :9711) | #f7f5fe --rail-bg | 4.74 | #100e1a --surface-2 | 5.2 | → DS-TOK-26 `--accent-wash` |
| `color-mix(in oklch, var(--ink) 30%, transparent)` | 2 (:999, :8193) | #b2b2b2 --border-strong | 1.4 | #515154 --rule | 4.16 | light matches DS-TOK-11 `--border-strong`, dark is ΔE00 7.76 from it (nearest dark: --rule): map or keep as a tint (could be deliberate) |
| `color-mix(in oklch, var(--accent) 35%, transparent)` | 2 (:1471, :4482) | #cec6f9 --accent-ring | 0 | #2e265b --accent-ring | 8.75 | → DS-TOK-15 `--accent-ring` |
| `color-mix(in oklch, var(--accent) 8%, transparent)` | 2 (:2122, :2431) | #f4f2fe --surface-2 | 6.02 | #12101e --surface-2 | 6.57 | → DS-TOK-26 `--accent-wash` |
| `color-mix(in oklch, var(--app-ink) 10%, transparent)` | 2 (:2702, :2732) | #fefefe --bg | 0.2 | #212124 --border | 0 | app strip ink ladder (painted on --app-chrome, not --bg; ΔE here is not meaningful): see note |
| `color-mix(in oklch, var(--app-ink) 20%, transparent)` | 2 (:2724, :2780) | #fefefe --bg | 0.2 | #3a3a3c --border-strong | 0 | app strip ink ladder (painted on --app-chrome, not --bg; ΔE here is not meaningful): see note |
| `color-mix(in oklch, var(--app-ink) 22%, transparent)` | 2 (:2729, :2735) | #fdfdfd --bg | 0.4 | #3d3d40 --border-strong | 1.19 | app strip ink ladder (painted on --app-chrome, not --bg; ΔE here is not meaningful): see note |
| `color-mix(in srgb, var(--ink) 30%, transparent)` | 2 (:4362, :10995) | #b2b2b2 --border-strong | 1.4 | #515154 --rule | 4.16 | light matches DS-TOK-11 `--border-strong`, dark is ΔE00 7.76 from it (nearest dark: --rule): map or keep as a tint (could be deliberate) |
| `color-mix(in oklch, white 20%, transparent)` | 2 (:6142, :6164) | #ffffff --bg | 0 | #3b3b3d --border-strong | 0.33 | on the hero cover (component-local, COMPOSITES) |
| `color-mix(in oklch, white 32%, transparent)` | 2 (:6149, :6162) | #ffffff --bg | 0 | #58585a --text-dim | 2.52 | on the hero cover (component-local, COMPOSITES) |
| `color-mix(in oklab, var(--paper) 62%, transparent)` | 2 (:6370, :6376) | #ffffff --bg | 0 | #09090c --bg | 0.17 | on the hero cover (component-local, COMPOSITES) |
| `color-mix(in oklch, var(--ink) 86%, var(--paper))` | 2 (:12304, :12305) | #090909 --void | 1.38 | #d2d2d2 --text-2 | 7.36 | no canonical twin: matches DS-TOK-18 `--void` in light by value only, dark is far from it (nearest dark --text-2); keep as a component tint or drop |
| `color-mix(in oklch, var(--border) 55%, transparent)` | 2 (:12474, :12474) | #eeeeee --surface-2 | 0.84 | #17171a --surface-2 | 0.71 | → DS-TOK-3 `--surface-2` (near-duplicate in both themes; dark ΔE00 0.71) |
| `color-mix(in oklch, var(--surface-2) 50%, var(--paper))` | 1 (:97) | #f8f8f8 --on-dark | 0 | #101013 --surface | 0.23 | no canonical twin: matches DS-TOK-16 `--on-dark` in light by value only, dark is far from it (nearest dark --surface); keep as a component tint or drop |
| `color-mix(in oklch, var(--ink) 82%, transparent)` | 1 (:377) | #2e2e2e --void | 10.28 | #cccccd --text-2 | 5.92 | no token within ΔE00 2: keep as a component tint or drop |
| `color-mix(in oklch, var(--on-dark) 78%, transparent)` | 1 (:378) | #fafafa --on-dark-muted | 0 | #c4c4c4 --text-2 | 3.96 | light matches DS-TOK-17 `--on-dark-muted`, dark is ΔE00 3.96 from it (nearest dark: --text-2): map or keep as a tint (could be deliberate) |
| `color-mix(in oklch, var(--accent) 4%, transparent)` | 1 (:538) | #faf9fe --on-dark-muted | 2.73 | #0e0d15 --surface | 2.87 | → DS-TOK-26 `--accent-wash` |
| `color-mix(in oklch, var(--ink) 4%, transparent)` | 1 (:918) | #f5f5f5 --rail-bg | 0.41 | #131316 --surface | 1 | light matches DS-TOK-5 `--rail-bg`, dark is ΔE00 2.01 from it (nearest dark: --surface): map or keep as a tint (could be deliberate) |
| `color-mix(in oklch, var(--on-dark) 35%, transparent)` | 1 (:1003) | #fdfdfd --bg | 0.4 | #5d5d5f --text-dim | 0.73 | no canonical twin: matches DS-TOK-1 `--bg` in light by value only, dark is far from it (nearest dark --text-dim); keep as a component tint or drop |
| `color-mix(in oklch, var(--accent) 40%, transparent)` | 1 (:1132) | #c7bef8 --accent-ring | 2.43 | #342b66 --accent-ring | 6.51 | → DS-TOK-15 `--accent-ring` |
| `color-mix(in oklch, var(--warning) 7%, transparent)` | 1 (:1144) | #fef8ee --on-dark | 4.92 | #1b160f --surface | 6.34 | no token within ΔE00 2: keep as a component tint or drop |
| `color-mix(in oklch, var(--accent) 75%, transparent)` | 1 (:1557) | #9785f2 --accent | 12.89 | #5947b5 --accent-ring | 8.32 | no token within ΔE00 2: keep as a component tint or drop |
| `color-mix(in oklch, currentColor 40%, transparent)` | 1 (:2035) | #999999 --border-strong | 6.02 | #69696a --text-dim | 3.76 | no token within ΔE00 2: keep as a component tint or drop |
| `color-mix(in oklch, var(--app-ink) 55%, transparent)` | 1 (:2700) | #fbfbfb --on-dark-muted | 0.2 | #8c8c8d --text-muted | 0 | app strip ink ladder (painted on --app-chrome, not --bg; ΔE here is not meaningful): see note |
| `color-mix(in oklch, var(--app-ink) 46%, transparent)` | 1 (:2713) | #fcfcfc --on-dark-muted | 0.4 | #777779 --text-muted | 7.87 | app strip ink ladder (painted on --app-chrome, not --bg; ΔE here is not meaningful): see note |
| `color-mix(in oklch, var(--app-ink) 7%, transparent)` | 1 (:2717) | #ffffff --bg | 0 | #1b1b1e --surface-3 | 0.94 | app strip ink ladder (painted on --app-chrome, not --bg; ΔE here is not meaningful): see note |
| `color-mix(in oklch, var(--app-ink) 12%, transparent)` | 1 (:2718) | #fefefe --bg | 0.2 | #262629 --app-chrome | 1.43 | app strip ink ladder (painted on --app-chrome, not --bg; ΔE here is not meaningful): see note |
| `color-mix(in oklch, var(--app-ink) 50%, transparent)` | 1 (:2719) | #fbfbfb --on-dark-muted | 0.2 | #818182 --text-muted | 3.98 | app strip ink ladder (painted on --app-chrome, not --bg; ΔE here is not meaningful): see note |
| `color-mix(in oklch, var(--app-ink) 60%, transparent)` | 1 (:2736) | #fbfbfb --on-dark-muted | 0.2 | #99999a --text-muted | 4.33 | app strip ink ladder (painted on --app-chrome, not --bg; ΔE here is not meaningful): see note |
| `color-mix(in oklch, var(--app-ink) 30%, transparent)` | 1 (:2744) | #fdfdfd --bg | 0.4 | #515154 --rule | 4.16 | app strip ink ladder (painted on --app-chrome, not --bg; ΔE here is not meaningful): see note |
| `color-mix(in oklch, var(--app-ink) 8%, transparent)` | 1 (:2745) | #fefefe --bg | 0.2 | #1c1c1e --surface-3 | 0.96 | app strip ink ladder (painted on --app-chrome, not --bg; ΔE here is not meaningful): see note |
| `color-mix(in oklch, var(--app-ink) 70%, transparent)` | 1 (:2746) | #fafafa --on-dark-muted | 0 | #b1b1b1 --text-2 | 1.26 | app strip ink ladder (painted on --app-chrome, not --bg; ΔE here is not meaningful): see note |
| `color-mix(in oklch, var(--text) 80%, var(--text-2))` | 1 (:3042) | #040303 --text | 0.64 | #eaeaea --text | 2.92 | light matches DS-TOK-6 `--text`, dark is ΔE00 2.92 from it (nearest dark: --text): map or keep as a tint (could be deliberate) |
| `color-mix(in oklch, var(--ink) 3%, transparent)` | 1 (:5128) | #f7f7f7 --rail-bg | 0 | #111114 --surface | 0.48 | → DS-TOK-5 `--rail-bg` (near-duplicate in both themes; dark ΔE00 1.49) |
| `color-mix(in oklch, white 16%, transparent)` | 1 (:6149) | #ffffff --bg | 0 | #313134 --border-strong | 2.97 | on the hero cover (component-local, COMPOSITES) |
| `color-mix(in oklch, white 12%, transparent)` | 1 (:6161) | #ffffff --bg | 0 | #27272a --app-chrome | 1.72 | on the hero cover (component-local, COMPOSITES) |
| `color-mix(in oklab, var(--accent) 14%, var(--paper))` | 1 (:6316) | #e9e9ff --surface-3 | 9.7 | #161527 --surface-2 | 8.96 | → DS-TOK-26 `--accent-wash` |
| `color-mix(in oklab, var(--ink) 22%, transparent)` | 1 (:6335) | #c7c7c7 --text-dim | 5.73 | #3d3d40 --border-strong | 1.19 | no token within ΔE00 2: keep as a component tint or drop |
| `color-mix(in oklab, var(--paper) 22%, transparent)` | 1 (:6372) | #ffffff --bg | 0 | #09090d --bg | 0.43 | on the hero cover (component-local, COMPOSITES) |
| `color-mix(in oklch, var(--ink) 1.6%, var(--paper))` | 1 (:7179) | #fafafa --on-dark-muted | 0 | #0d0d0f --bg | 0.61 | no canonical twin: matches DS-TOK-17 `--on-dark-muted` in light by value only, dark is far from it (nearest dark --bg); keep as a component tint or drop |
| `color-mix(in srgb, var(--ink) 4%, var(--paper))` | 1 (:7915) | #f5f5f5 --rail-bg | 0.41 | #131316 --surface | 1 | light matches DS-TOK-5 `--rail-bg`, dark is ΔE00 2.01 from it (nearest dark: --surface): map or keep as a tint (could be deliberate) |
| `color-mix(in oklch, var(--accent) 55%, transparent)` | 1 (:8176) | #b3a6f6 --accent-ring | 9.52 | #443788 --accent-ring | 0 | → DS-TOK-15 `--accent-ring` |
| `color-mix(in oklch, var(--ink) 18%, transparent)` | 1 (:8188) | #d1d1d1 --border | 3.46 | #353537 --border-strong | 1.62 | no token within ΔE00 2: keep as a component tint or drop |
| `color-mix(in srgb, var(--ink) 3%, transparent)` | 1 (:8743) | #f7f7f7 --rail-bg | 0 | #111114 --surface | 0.48 | → DS-TOK-5 `--rail-bg` (near-duplicate in both themes; dark ΔE00 1.49) |
| `color-mix(in srgb, var(--border) 22%, transparent)` | 1 (:8895) | #f8f8f8 --on-dark | 0 | #0f0f12 --surface | 0 | no canonical twin: matches DS-TOK-16 `--on-dark` in light by value only, dark is far from it (nearest dark --surface); keep as a component tint or drop |
| `color-mix(in oklch, currentColor 62%, transparent)` | 1 (:11830) | #616161 --text-2 | 5.03 | #9d9d9e --text-muted | 5.59 | no token within ΔE00 2: keep as a component tint or drop |
| `color-mix(in srgb, var(--accent) 45%, transparent)` | 1 (:12648) | #c0b5f7 --accent-ring | 5.06 | #392e72 --accent-ring | 4.26 | → DS-TOK-15 `--accent-ring` |
| `oklch(0 0 0 / 0.4)` | literal | #999999 --border-strong | 6.02 | #060607 --bg | 1.15 | → DS-TOK-25 `--scrim` |
| `rgba(0, 0, 0, 0.4)` | literal | #999999 --border-strong | 6.02 | #060607 --bg | 1.15 | → DS-TOK-25 `--scrim` |
| `rgba(0, 0, 0, 0.45)` | literal | #8c8c8c --text-muted | 4.77 | #050507 --bg | 0.96 | part of DS-TOK-75 `--shadow-overlay` (hub-ds/foundation.css:89); keep |
| `#fff` | literal | #ffffff --bg | 0 | #ffffff --text | 1.4 | → DS-TOK-16 `--on-dark` (ΔE00 1.4) |
| `white` | literal | #ffffff --bg | 0 | #ffffff --text | 1.4 | on the hero cover (component-local, COMPOSITES) |

### Font-size literals in app.css

77 distinct values across 799 declarations (`font-size` and the `font` shorthand). Rows whose value already is a canonical token are left out. Tolerance: 2 px. Many fractional sizes (13.12, 12.48, 10.24, 9.92) are not literals at all: they come from `em` multipliers stacking on 14px, and are listed in the census below.

| Literal | Declarations | Examples | → Canonical | Gap | Verdict |
|---|---|---|---|---|---|
| `var(--fs-mono-sm)` | 251 | app.css:116, app.css:187, app.css:273 | DS-TOK-43 `--text-label` |  | alias token, rename |
| `.8125rem` | 39 | app.css:2694, app.css:2730, app.css:3003 | DS-TOK-42 `--text-sm` | 0 | equal |
| `.875rem` | 27 | app.css:702, app.css:715, app.css:1771 | DS-TOK-41 `--text-body` | 0 | equal |
| `.8rem` | 22 | app.css:1846, app.css:2364, app.css:2414 | DS-TOK-42 `--text-sm` | 0.20 px | near (drift) |
| `1rem` | 18 | app.css:817, app.css:1022, app.css:1514 | DS-TOK-39 `--text-h3` | 0 | equal |
| `.75rem` | 18 | app.css:2705, app.css:3014, app.css:6326 | DS-TOK-43 `--text-label` | 0 | equal |
| `.9rem` | 17 | app.css:1595, app.css:1762, app.css:1804 | DS-TOK-41 `--text-body` | 0.40 px | near (drift) |
| `.85rem` | 17 | app.css:1739, app.css:2086, app.css:2087 | DS-TOK-41 `--text-body` | 0.40 px | near (drift) |
| `1.05rem` | 11 | app.css:609, app.css:700, app.css:3943 | DS-TOK-39 `--text-h3` | 0.80 px | near (drift) |
| `.7rem` | 11 | app.css:865, app.css:1448, app.css:2733 | DS-TOK-44 `--text-overline` | 0.20 px | near (drift) |
| `.625rem` | 11 | app.css:5209, app.css:6424, app.css:6485 | DS-TOK-45 `--text-micro` | 0 | equal |
| `.78125rem` | 10 | app.css:6373, app.css:6568, app.css:6657 | DS-TOK-42 `--text-sm` | 0.50 px | near (drift) |
| `0.875rem` | 8 | app.css:133, app.css:173, app.css:339 | DS-TOK-41 `--text-body` | 0 | equal |
| `1.0625rem` | 8 | app.css:1424, app.css:1425, app.css:2131 | DS-TOK-39 `--text-h3` | 1.00 px | near (drift) |
| `.82rem` | 8 | app.css:2350, app.css:2925, app.css:2951 | DS-TOK-42 `--text-sm` | 0.12 px | near (drift) |
| `.9375rem` | 8 | app.css:2815, app.css:4177, app.css:6167 | DS-TOK-40 `--text-body-lg` | 0 | equal |
| `var(--fs-lead)` | 7 | app.css:565, app.css:596, app.css:767 | DS-TOK-38 `--text-h2` |  | alias token, rename |
| `.78rem` | 7 | app.css:705, app.css:709, app.css:738 | DS-TOK-43 `--text-label` | 0.48 px | near (drift) |
| `.95rem` | 7 | app.css:3059, app.css:3613, app.css:3980 | DS-TOK-40 `--text-body-lg` | 0.20 px | near (drift) |
| `1.5rem` | 5 | app.css:186, app.css:195, app.css:2893 | DS-TOK-37 `--text-h1` | 0 | equal |
| `0.8125rem` | 5 | app.css:243, app.css:430, app.css:514 | DS-TOK-42 `--text-sm` | 0 | equal |
| `.85em` | 5 | app.css:1413, app.css:2486, app.css:9245 | relative (em): keep relative or convert |  | relative |
| `.5625rem` | 5 | app.css:2990, app.css:5211, app.css:5455 | DS-TOK-45 `--text-micro` | 1.00 px | near (drift) |
| `.6875rem` | 5 | app.css:6408, app.css:6409, app.css:7219 | DS-TOK-44 `--text-overline` | 0 | equal |
| `0.6875rem` | 4 | app.css:58, app.css:568, app.css:746 | DS-TOK-44 `--text-overline` | 0 | equal |
| `0.9375rem` | 4 | app.css:242, app.css:477, app.css:3533 | DS-TOK-40 `--text-body-lg` | 0 | equal |
| `.84375rem` | 4 | app.css:6482, app.css:6701, app.css:6737 | DS-TOK-41 `--text-body` | 0.50 px | near (drift) |
| `1.3rem` | 3 | app.css:194, app.css:1575, app.css:7008 | DS-TOK-38 `--text-h2` | 0.80 px | near (drift) |
| `.68rem` | 3 | app.css:2485, app.css:2723, app.css:3057 | DS-TOK-44 `--text-overline` | 0.12 px | near (drift) |
| `.71875rem` | 3 | app.css:6381, app.css:6483, app.css:6774 | DS-TOK-43 `--text-label` | 0.50 px | near (drift) |
| `.5rem` | 3 | app.css:9431, app.css:10933, app.css:12638 | DS-TOK-45 `--text-micro` | 2.00 px | near (drift) |
| `var(--fs-mono)` | 2 | app.css:27, app.css:31 | DS-TOK-41 `--text-body` |  | alias token, rename |
| `0.75rem` | 2 | app.css:354, app.css:567 | DS-TOK-43 `--text-label` | 0 | equal |
| `0.625rem` | 2 | app.css:433, app.css:441 | DS-TOK-45 `--text-micro` | 0 | equal |
| `1.125rem` | 2 | app.css:502, app.css:7532 | DS-TOK-38 `--text-h2` | 2.00 px | near (drift) |
| `.9em` | 2 | app.css:1458, app.css:2396 | relative (em): keep relative or convert |  | relative |
| `.52rem` | 2 | app.css:1633, app.css:2509 | DS-TOK-45 `--text-micro` | 1.68 px | near (drift) |
| `.58rem` | 2 | app.css:3038, app.css:11273 | DS-TOK-45 `--text-micro` | 0.72 px | near (drift) |
| `1.25rem` | 2 | app.css:4172, app.css:4286 | DS-TOK-38 `--text-h2` | 0 | equal |
| `.65rem` | 2 | app.css:6769, app.css:6858 | DS-TOK-45 `--text-micro` | 0.40 px | near (drift) |
| `0.84rem` | 1 | app.css:181 | DS-TOK-42 `--text-sm` | 0.44 px | near (drift) |
| `1.6rem` | 1 | app.css:188 | DS-TOK-47 `--text-num-md` | 0.40 px | near (drift) |
| `2.125rem` | 1 | app.css:268 | DS-TOK-46 `--text-num-lg` | 0 | equal |
| `0.42em` | 1 | app.css:271 | relative (em): keep relative or convert |  | relative |
| `0.65em` | 1 | app.css:327 | relative (em): keep relative or convert |  | relative |
| `11px` | 1 | app.css:625 | DS-TOK-44 `--text-overline` | 0 | equal |
| `1.75rem` | 1 | app.css:677 | DS-TOK-36 `--fs-title` | 0 | equal |
| `clamp(1.15rem, 1.9vw, 1.6rem)` | 1 | app.css:1047 | n/a |  | keyword/calc |
| `1.15rem` | 1 | app.css:1593 | DS-TOK-38 `--text-h2` | 1.60 px | near (drift) |
| `1.9rem` | 1 | app.css:1594 | no token |  | drift (no step within 2 px): propose or drop |
| `0.9rem` | 1 | app.css:2328 | DS-TOK-41 `--text-body` | 0.40 px | near (drift) |
| `.44rem` | 1 | app.css:2747 | no token |  | drift (no step within 2 px): propose or drop |
| `.6rem` | 1 | app.css:5131 | DS-TOK-45 `--text-micro` | 0.40 px | near (drift) |
| `clamp(2rem, 5vw, 3.1rem)` | 1 | app.css:6146 | n/a |  | keyword/calc |
| `1.7rem` | 1 | app.css:6152 | DS-TOK-36 `--fs-title` | 0.80 px | near (drift) |
| `.72rem` | 1 | app.css:6762 | DS-TOK-43 `--text-label` | 0.48 px | near (drift) |
| `.8em` | 1 | app.css:7539 | relative (em): keep relative or convert |  | relative |
| `.75em` | 1 | app.css:8277 | relative (em): keep relative or convert |  | relative |
| `var(--fs-h3)` | 1 | app.css:9086 | DS-TOK-35 `--text-display` |  | alias token, rename |
| `.55rem` | 1 | app.css:11268 | DS-TOK-45 `--text-micro` | 1.20 px | near (drift) |
| `1.1rem` | 1 | app.css:11276 | DS-TOK-39 `--text-h3` | 1.60 px | near (drift) |
| `1em` | 1 | app.css:12052 | relative (em): keep relative or convert |  | relative |
| `clamp(1.75rem, 3.1vw, 3.4rem)` | 1 | app.css:12741 | n/a |  | keyword/calc |
| `.63rem` | 1 | app.css:12856 | DS-TOK-45 `--text-micro` | 0.08 px | near (drift) |
| `clamp(1.65rem, 9vw, 2.6rem)` | 1 | app.css:12909 | n/a |  | keyword/calc |

### Spacing literals in app.css

58 distinct literal values in `padding`, `margin` and `gap` (663 occurrences), beside 876 token references. The mockup has a dense sub-step scale (.1rem to .6rem) that the DS never declared; the two proposed half steps (`--s-0-5` 2px, `--s-1-5` 6px) absorb most of it.

| Literal | Declarations | Examples | → Canonical | Gap | Verdict |
|---|---|---|---|---|---|
| `.35rem` | 83 | app.css:820, app.css:1132, app.css:1309 | DS-TOK-59 `--s-1-5` | 0.40 px | near (drift) |
| `.3rem` | 78 | app.css:709, app.css:942, app.css:1026 | DS-TOK-58 `--s-1` | 0.80 px | near (drift) |
| `.5rem` | 68 | app.css:737, app.css:1396, app.css:1496 | DS-TOK-60 `--s-2` | 0 | equal |
| `.4rem` | 64 | app.css:706, app.css:1401, app.css:1402 | DS-TOK-59 `--s-1-5` | 0.40 px | near (drift) |
| `.15rem` | 49 | app.css:312, app.css:787, app.css:1141 | DS-TOK-57 `--s-0-5` | 0.40 px | near (drift) |
| `.25rem` | 49 | app.css:788, app.css:1093, app.css:1303 | DS-TOK-58 `--s-1` | 0 | equal |
| `.45rem` | 43 | app.css:715, app.css:897, app.css:1388 | DS-TOK-60 `--s-2` | 0.80 px | near (drift) |
| `.2rem` | 42 | app.css:849, app.css:1183, app.css:1495 | DS-TOK-58 `--s-1` | 0.80 px | near (drift) |
| `.1rem` | 40 | app.css:314, app.css:1059, app.css:1132 | DS-TOK-57 `--s-0-5` | 0.40 px | near (drift) |
| `.55rem` | 30 | app.css:1035, app.css:1396, app.css:1502 | DS-TOK-60 `--s-2` | 0.80 px | near (drift) |
| `.6rem` | 23 | app.css:702, app.css:709, app.css:715 | DS-TOK-60 `--s-2` | 1.60 px | near (drift) |
| `1.1rem` | 7 | app.css:428, app.css:1515, app.css:6168 | DS-TOK-62 `--s-4` | 1.60 px | near (drift) |
| `2px` | 6 | app.css:381, app.css:440, app.css:2108 | DS-TOK-57 `--s-0-5` | 0 | equal |
| `.7rem` | 6 | app.css:737, app.css:2948, app.css:2951 | DS-TOK-61 `--s-3` | 0.80 px | near (drift) |
| `-1px` | 4 | app.css:134, app.css:5985, app.css:7326 | DS-TOK-57 `--s-0-5` | 1.00 px | near (drift) |
| `0.4rem` | 4 | app.css:148, app.css:352, app.css:517 | DS-TOK-59 `--s-1-5` | 0.40 px | near (drift) |
| `.8rem` | 4 | app.css:702, app.css:5105, app.css:6380 | DS-TOK-61 `--s-3` | 0.80 px | near (drift) |
| `2rem` | 4 | app.css:1127, app.css:1771, app.css:1807 | DS-TOK-64 `--s-6` | 0 | equal |
| `.65rem` | 4 | app.css:2816, app.css:5408, app.css:6839 | DS-TOK-61 `--s-3` | 1.60 px | near (drift) |
| `.22rem` | 4 | app.css:6671, app.css:7113, app.css:7117 | DS-TOK-58 `--s-1` | 0.48 px | near (drift) |
| `0.7rem` | 3 | app.css:118, app.css:372, app.css:382 | DS-TOK-61 `--s-3` | 0.80 px | near (drift) |
| `1.05rem` | 3 | app.css:1602, app.css:1855, app.css:10309 | DS-TOK-62 `--s-4` | 0.80 px | near (drift) |
| `0.35rem` | 2 | app.css:118, app.css:509 | DS-TOK-59 `--s-1-5` | 0.40 px | near (drift) |
| `0.65rem` | 2 | app.css:132, app.css:347 | DS-TOK-61 `--s-3` | 1.60 px | near (drift) |
| `0.45rem` | 2 | app.css:172, app.css:465 | DS-TOK-60 `--s-2` | 0.80 px | near (drift) |
| `0.25rem` | 2 | app.css:212, app.css:320 | DS-TOK-58 `--s-1` | 0 | equal |
| `0.55rem` | 2 | app.css:341, app.css:353 | DS-TOK-60 `--s-2` | 0.80 px | near (drift) |
| `.28rem` | 2 | app.css:1035, app.css:6372 | DS-TOK-58 `--s-1` | 0.48 px | near (drift) |
| `2.4rem` | 2 | app.css:1083, app.css:5044 | no token |  | drift (no step within 2 px): propose or drop |
| `.05rem` | 2 | app.css:3039, app.css:9055 | DS-TOK-57 `--s-0-5` | 1.20 px | near (drift) |
| `2.25rem` | 2 | app.css:5797, app.css:6119 | no token |  | drift (no step within 2 px): propose or drop |
| `0.5em` | 1 | app.css:56 | relative (em): keep relative or convert |  | relative |
| `0.3em` | 1 | app.css:57 | relative (em): keep relative or convert |  | relative |
| `0.75em` | 1 | app.css:57 | relative (em): keep relative or convert |  | relative |
| `0.06em` | 1 | app.css:269 | relative (em): keep relative or convert |  | relative |
| `0.3rem` | 1 | app.css:428 | DS-TOK-58 `--s-1` | 0.80 px | near (drift) |
| `0.2rem` | 1 | app.css:556 | DS-TOK-58 `--s-1` | 0.80 px | near (drift) |
| `4rem` | 1 | app.css:1042 | DS-TOK-66 `--s-8` | 0 | equal |
| `1.15rem` | 1 | app.css:2327 | no token |  | drift (no step within 2 px): propose or drop |
| `1.85rem` | 1 | app.css:2468 | no token |  | drift (no step within 2 px): propose or drop |
| `-.18rem` | 1 | app.css:2509 | DS-TOK-57 `--s-0-5` | 0.88 px | near (drift) |
| `-.1rem` | 1 | app.css:2747 | DS-TOK-57 `--s-0-5` | 0.40 px | near (drift) |
| `2.6rem` | 1 | app.css:4024 | no token |  | drift (no step within 2 px): propose or drop |
| `2.2rem` | 1 | app.css:4190 | no token |  | drift (no step within 2 px): propose or drop |
| `.9rem` | 1 | app.css:5105 | DS-TOK-62 `--s-4` | 1.60 px | near (drift) |
| `40px` | 1 | app.css:6055 | no token |  | drift (no step within 2 px): propose or drop |
| `-9px` | 1 | app.css:6362 | DS-TOK-60 `--s-2` | 1.00 px | near (drift) |
| `.75rem` | 1 | app.css:7325 | DS-TOK-61 `--s-3` | 0 | equal |
| `1.3rem` | 1 | app.css:7362 | no token |  | drift (no step within 2 px): propose or drop |
| `.38rem` | 1 | app.css:9499 | DS-TOK-59 `--s-1-5` | 0.08 px | near (drift) |
| `1px` | 1 | app.css:9694 | DS-TOK-57 `--s-0-5` | 1.00 px | near (drift) |
| `1rem` | 1 | app.css:10584 | DS-TOK-62 `--s-4` | 0 | equal |
| `1.4rem` | 1 | app.css:10788 | DS-TOK-63 `--s-5` | 1.60 px | near (drift) |
| `0.4em` | 1 | app.css:11167 | relative (em): keep relative or convert |  | relative |
| `0.1em` | 1 | app.css:11169 | relative (em): keep relative or convert |  | relative |
| `.85rem` | 1 | app.css:11967 | DS-TOK-61 `--s-3` | 1.60 px | near (drift) |
| `-.55rem` | 1 | app.css:12523 | DS-TOK-60 `--s-2` | 0.80 px | near (drift) |
| `-1.55rem` | 1 | app.css:12919 | DS-TOK-63 `--s-5` | 0.80 px | near (drift) |

### Line-height, tracking and weight literals

| line-height | Declarations | Examples | → Canonical |
|---|---|---|---|
| `1` | 91 | app.css:59, app.css:268, app.css:327 | DS-TOK-49 `--leading-none` |
| `1.5` | 31 | app.css:275, app.css:418, app.css:481 | DS-TOK-52 `--leading-normal` |
| `var(--lh-body)` | 25 | app.css:796, app.css:1051, app.css:1093 | DS-TOK-51 `--lh-body` |
| `1.45` | 18 | app.css:477, app.css:596, app.css:739 | DS-TOK-52 `--leading-normal` |
| `1.35` | 8 | app.css:3823, app.css:6373, app.css:7350 | DS-TOK-51 `--lh-body` |
| `1.2` | 6 | app.css:242, app.css:1804, app.css:1943 | DS-TOK-50 `--lh-title` |
| `1.55` | 6 | app.css:2573, app.css:4541, app.css:5673 | DS-TOK-52 `--leading-normal` |
| `1.25` | 5 | app.css:502, app.css:3059, app.css:3613 | DS-TOK-50 `--lh-title` |
| `1.4` | 5 | app.css:3038, app.css:3845, app.css:5002 | DS-TOK-51 `--lh-body` |
| `1.3` | 4 | app.css:1033, app.css:5132, app.css:5406 | DS-TOK-51 `--lh-body` |
| `var(--leading-snug)` | 4 | app.css:12570, app.css:12680, app.css:12795 | DS-TOK-51 `--lh-body` (alias) |
| `var(--lh-title)` | 3 | app.css:21, app.css:768, app.css:8105 | DS-TOK-50 `--lh-title` |
| `1.1` | 2 | app.css:188, app.css:12837 | DS-TOK-50 `--lh-title` |
| `var(--leading-tight)` | 2 | app.css:1047, app.css:12665 | DS-TOK-50 `--lh-title` (alias) |
| `1.7` | 2 | app.css:1603, app.css:6168 | DS-TOK-52 `--leading-normal` |
| `1.6` | 2 | app.css:6949, app.css:7529 | DS-TOK-52 `--leading-normal` |
| `var(--msg-line)` | 1 | app.css:3004 | `--msg-line` |
| `1.04` | 1 | app.css:6146 | DS-TOK-50 `--lh-title` |
| `0` | 1 | app.css:6405 | keep (special) |
| `inherit` | 1 | app.css:10084 | keep (special) |
| `.98` | 1 | app.css:12742 | DS-TOK-49 `--leading-none` |

| letter-spacing | Declarations | Examples | → Canonical |
|---|---|---|---|
| `var(--tracking-label)` | 94 | app.css:28, app.css:117, app.css:166 | DS-TOK-55 `--tracking-label` |
| `var(--tracking-tight)` | 5 | app.css:22, app.css:188, app.css:196 | DS-TOK-54 `--tracking-tight` |
| `var(--tracking-display)` | 3 | app.css:268, app.css:6146, app.css:12742 | DS-TOK-53 `--tracking-display` |
| `normal` | 3 | app.css:739, app.css:1778, app.css:5002 | none (0) |
| `0` | 3 | app.css:3329, app.css:6607, app.css:12525 | none (0) |
| `.04em` | 3 | app.css:6375, app.css:10268, app.css:10761 | DS-TOK-55 `--tracking-label` |
| `0.06em` | 2 | app.css:59, app.css:11177 | DS-TOK-56 `--tracking-caps` |
| `.06em` | 2 | app.css:11313, app.css:12650 | DS-TOK-56 `--tracking-caps` |
| `.02em` | 1 | app.css:2082 | DS-TOK-55 `--tracking-label` |
| `.08em` | 1 | app.css:11297 | DS-TOK-56 `--tracking-caps` |
| `.045em` | 1 | app.css:12856 | DS-TOK-55 `--tracking-label` |

| font-weight | Declarations | Examples | → Canonical |
|---|---|---|---|
| `var(--weight-medium)` | 68 | app.css:20, app.css:133, app.css:176 | DS-TOK-33 `--weight-medium` |
| `500` | 39 | app.css:1367, app.css:1594, app.css:2819 | DS-TOK-33 `--weight-medium` |
| `600` | 19 | app.css:186, app.css:242, app.css:478 | DS-TOK-34 `--weight-semibold` |
| `400` | 11 | app.css:31, app.css:34, app.css:58 | DS-TOK-32 `--weight-regular` |
| `300` | 7 | app.css:27, app.css:116, app.css:273 | DS-TOK-31 `--weight-light` |
| `var(--weight-semibold)` | 7 | app.css:12519, app.css:12614, app.css:12665 | DS-TOK-34 `--weight-semibold` |
| `var(--weight-body)` | 2 | app.css:738, app.css:5001 | DS-TOK-32 `--weight-regular` (alias) |
| `var(--weight-regular)` | 2 | app.css:5411, app.css:6936 | DS-TOK-32 `--weight-regular` |

Families: `var(--font-mono)` ×189, `var(--font-display)` ×24, `var(--font-sans)` ×16, `inherit` ×4. No literal family names in app.css. The only stray family is the browser `monospace` on `code` (see DS-TOK-30 `--font-mono`).

### Radius, shadow and outline literals

| border-radius | Declarations | Examples | → Canonical |
|---|---|---|---|
| `50%` | 13 | app.css:2079, app.css:2507, app.css:2987 | DS-TOK-71 `--radius-round` |
| `0` | 7 | app.css:1806, app.css:1945, app.css:1996 | DS-TOK-69 `--radius-none` |
| `var(--radius-pill)` | 1 | app.css:57 | DS-TOK-70 `--radius-pill` |
| `var(--radius-none)` | 1 | app.css:528 | DS-TOK-69 `--radius-none` |
| `inherit` | 1 | app.css:2985 | keep |

| box-shadow | Declarations | Examples | → Canonical |
|---|---|---|---|
| `none` | 11 | app.css:1251, app.css:4505, app.css:4579 | none |
| `var(--shadow-overlay)` | 6 | app.css:652, app.css:1960, app.css:2401 | DS-TOK-75 `--shadow-overlay` |
| `-10px 0 10px -10px color-mix(in srgb, var(--ink) 30%, transparent)` | 2 | app.css:4362, app.css:10995 | DS-TOK-76 `--shadow-edge` |
| `inset 0 0 0 1px var(--accent)` | 2 | app.css:9250, app.css:10617 | component rule drawn as a shadow: hand to PRIMITIVES/COMPOSITES (accent bar, inset ring) |
| `0 0 0 3px color-mix(in oklch, var(--accent) 75%, transparent)` | 1 | app.css:1557 | locate-flash keyframe (DS-TOK-83 `--dur-flash`), keep in component |
| `0 0 0 3px transparent` | 1 | app.css:1558 | locate-flash keyframe (DS-TOK-83 `--dur-flash`), keep in component |
| `inset 3px 0 0 var(--accent)` | 1 | app.css:1585 | component rule drawn as a shadow: hand to PRIMITIVES/COMPOSITES (accent bar, inset ring) |
| `var(--shadow-sm)` | 1 | app.css:4650 | DS-TOK-72 `--shadow-sm` |
| `var(--shadow-2, 0 6px 20px color-mix(in oklab, var(--ink) 22%, transparent))` | 1 | app.css:6335 | DS-TOK-73 `--shadow` (phantom --shadow-2) |
| `inset 3px 0 0 0 var(--accent)` | 1 | app.css:9785 | component rule drawn as a shadow: hand to PRIMITIVES/COMPOSITES (accent bar, inset ring) |
| `inset 0 0 0 1px var(--mock-edge)` | 1 | app.css:10505 | mockup overlay only, excluded |
| `inset 0 -2px 0 var(--accent)` | 1 | app.css:12771 | component rule drawn as a shadow: hand to PRIMITIVES/COMPOSITES (accent bar, inset ring) |
| `inset 0 0 0 1px var(--border-strong)` | 1 | app.css:12849 | component rule drawn as a shadow: hand to PRIMITIVES/COMPOSITES (accent bar, inset ring) |
| `inset 0 0 0 1px var(--warning)` | 1 | app.css:12870 | component rule drawn as a shadow: hand to PRIMITIVES/COMPOSITES (accent bar, inset ring) |

| outline | Declarations | Examples | → Canonical |
|---|---|---|---|
| `none` | 26 | app.css:717, app.css:1028, app.css:1637 | none (pair every one with a --focus-ring on :focus-visible; PRIMITIVES lane checks) |
| `var(--focus-ring)` | 5 | app.css:862, app.css:1030, app.css:1038 | DS-TOK-77 `--focus-ring` |
| `2px` | 3 | app.css:1038, app.css:10542, app.css:12814 | outline width/offset part of a focus rule |
| `1px` | 3 | app.css:9295, app.css:9807, app.css:12509 | outline width/offset part of a focus rule |
| `1px solid var(--accent)` | 2 | app.css:530, app.css:1998 | DS-TOK-77 `--focus-ring` |
| `-2px` | 2 | app.css:862, app.css:7181 | outline width/offset part of a focus rule |
| `2px solid var(--accent)` | 2 | app.css:7181, app.css:12509 | DS-TOK-77 `--focus-ring` |
| `-1px` | 1 | app.css:530 | outline width/offset part of a focus rule |
| `4px` | 1 | app.css:1030 | outline width/offset part of a focus rule |
| `1px dashed var(--border-strong)` | 1 | app.css:1995 | outline width/offset part of a focus rule |
| `3px` | 1 | app.css:1995 | outline width/offset part of a focus rule |
| `2px solid var(--focus, currentColor)` | 1 | app.css:10542 | DS-TOK-77 `--focus-ring` (phantom --focus) |
| `2px solid var(--focus)` | 1 | app.css:12814 | DS-TOK-77 `--focus-ring` (phantom --focus) |

Border widths: `1px` ×354 (the hairline, no token needed: the rule is 1px `--border`), `2px` ×29, `3px` ×11 (accent bars and tab marks), `9px` ×4, `4px` ×2, `5px` ×1, `1.5px` ×1 (app.css:12636). The odd ones belong to their components (PRIMITIVES and COMPOSITES).

### Motion literals

| duration | Declarations | Examples | → Canonical |
|---|---|---|---|
| `var(--dur-1)` | 26 | app.css:648, app.css:648, app.css:653 | DS-TOK-81 `--dur-1` |
| `var(--dur-fast)` | 25 | app.css:1634, app.css:1634, app.css:2234 | DS-TOK-79 `--dur-fast` |
| `.15s` | 10 | app.css:2937, app.css:3052, app.css:3058 | DS-TOK-79 `--dur-fast` |
| `var(--dur-2)` | 7 | app.css:2245, app.css:2313, app.css:2313 | DS-TOK-82 `--dur-2` |
| `0s` | 4 | app.css:648, app.css:653, app.css:691 | keep: reduced-motion and instant resets |
| `120ms` | 3 | app.css:866, app.css:8529, app.css:8603 | DS-TOK-79 `--dur-fast` |
| `1.5s` | 1 | app.css:1555 | DS-TOK-83 `--dur-flash` |

| easing | Declarations | Examples | → Canonical |
|---|---|---|---|
| `var(--ease)` | 46 | app.css:1634, app.css:1634, app.css:2231 | DS-TOK-78 `--ease` |
| `ease` | 16 | app.css:866, app.css:866, app.css:2937 | DS-TOK-78 `--ease` |
| `var(--ease-out)` | 10 | app.css:648, app.css:653, app.css:662 | DS-TOK-78 `--ease` (alias) |

### Z-index literals

No z-index token exists in the mockup or the DS. 17 distinct values in 40 declarations; the proposed layer tokens (DS-TOK group "Z-index layers") name the ladder that is already there.

| z-index | Declarations | Examples | → Canonical |
|---|---|---|---|
| `2` | 7 | app.css:1633, app.css:4651, app.css:6157 | DS-TOK-93 `--z-raised` |
| `1` | 5 | app.css:5906, app.css:6143, app.css:6181 | DS-TOK-93 `--z-raised` |
| `40` | 4 | app.css:1957, app.css:2400, app.css:4810 | DS-TOK-95 `--z-popover` |
| `auto` | 3 | app.css:4506, app.css:4580, app.css:4705 | keep auto |
| `45` | 3 | app.css:4969, app.css:11292, app.css:11662 | --z-dock-rail / --z-popover (menus) |
| `60` | 2 | app.css:649, app.css:4429 | DS-TOK-98 `--z-nav` |
| `70` | 2 | app.css:685, app.css:6030 | DS-TOK-100 `--z-panel` |
| `80` | 2 | app.css:737, app.css:5000 | DS-TOK-101 `--z-tooltip` |
| `5` | 2 | app.css:1469, app.css:4481 | DS-TOK-93 `--z-raised` |
| `30` | 2 | app.css:2600, app.css:2769 | DS-TOK-94 `--z-sticky` |
| `0` | 2 | app.css:4764, app.css:12820 | keep 0 |
| `55` | 1 | app.css:657 | DS-TOK-97 `--z-backdrop` |
| `72` | 1 | app.css:3772 | not built (`.sb` is dead, DR-19) |
| `65` | 1 | app.css:11079 | DS-TOK-99 `--z-chrome-lift` |
| `3` | 1 | app.css:11530 | DS-TOK-93 `--z-raised` |
| `12` | 1 | app.css:11705 | --z-sticky (board-local) |
| `11` | 1 | app.css:11722 | --z-sticky (board-local) |

### Icon-size literals

Font sizes on icon and glyph selectors (`.fi`, `i`, `__ico`, `__icon`, `__mark`). Tolerance 2 px.

| Literal | Declarations | Examples | → Canonical | Gap | Verdict |
|---|---|---|---|---|---|
| `.75rem` | 8 | app.css:2705, app.css:6326, app.css:6817 | DS-TOK-103 `--icon-sm` | 0 | equal |
| `.8rem` | 7 | app.css:4160, app.css:5223, app.css:5561 | DS-TOK-103 `--icon-sm` | 0.80 px | near (drift) |
| `1rem` | 5 | app.css:817, app.css:1022, app.css:1514 | DS-TOK-104 `--icon-md` | 0 | equal |
| `.85em` | 5 | app.css:1413, app.css:2486, app.css:9245 | DS-TOK-106 `--icon-door` (relative to host) |  | relative |
| `.8125rem` | 5 | app.css:7126, app.css:7258, app.css:9368 | DS-TOK-103 `--icon-sm` | 1.00 px | near (drift) |
| `.7rem` | 4 | app.css:2733, app.css:6382, app.css:6672 | DS-TOK-103 `--icon-sm` | 0.80 px | near (drift) |
| `.9rem` | 4 | app.css:5585, app.css:5618, app.css:6696 | DS-TOK-104 `--icon-md` | 1.60 px | near (drift) |
| `1.5rem` | 2 | app.css:186, app.css:6149 | DS-TOK-105 `--icon-lg` | 0 | equal |
| `var(--fs-mono-sm)` | 2 | app.css:540, app.css:4557 | DS-TOK-43 `--text-label` |  | alias token, rename |
| `.9em` | 2 | app.css:1458, app.css:2396 | DS-TOK-106 `--icon-door` (relative to host) |  | relative |
| `.875rem` | 2 | app.css:4556, app.css:9405 | DS-TOK-103 `--icon-sm` | 2.00 px | near (drift) |
| `.85rem` | 2 | app.css:7349, app.css:10774 | DS-TOK-103 `--icon-sm` | 1.60 px | near (drift) |
| `.68rem` | 1 | app.css:3057 | DS-TOK-103 `--icon-sm` | 1.12 px | near (drift) |
| `.95rem` | 1 | app.css:4472 | DS-TOK-104 `--icon-md` | 0.80 px | near (drift) |
| `.78125rem` | 1 | app.css:6568 | DS-TOK-103 `--icon-sm` | 0.50 px | near (drift) |
| `.72rem` | 1 | app.css:6762 | DS-TOK-103 `--icon-sm` | 0.48 px | near (drift) |
| `.65rem` | 1 | app.css:6858 | DS-TOK-103 `--icon-sm` | 1.60 px | near (drift) |
| `1.05rem` | 1 | app.css:7067 | DS-TOK-104 `--icon-md` | 0.80 px | near (drift) |
| `.9375rem` | 1 | app.css:7522 | DS-TOK-104 `--icon-md` | 1.00 px | near (drift) |
| `.55rem` | 1 | app.css:11268 | DS-TOK-102 `--icon-xs` | 0.80 px | near (drift) |
| `1em` | 1 | app.css:12052 | DS-TOK-106 `--icon-door` (relative to host) |  | relative |
| `.5rem` | 1 | app.css:12638 | DS-TOK-102 `--icon-xs` | 0 | equal |

### Media queries

Custom properties cannot be used inside `@media`, so the mockup repeats the numbers; the tokens name them for the build (where a preprocessor or `@custom-media` can use them).

| Query | Blocks | Example | → Canonical |
|---|---|---|---|
| `media (max-width: 640px)` | 43 | app.css:197, app.css:410, app.css:674 | DS-TOK-84 `--bp-mobile` |
| `media (max-width: 900px)` | 39 | app.css:531, app.css:634, app.css:718 | DS-TOK-85 `--bp-tablet` |
| `media print` | 30 | app.css:617, app.css:1320, app.css:1924 | not a width |
| `media not all and (max-width: 900px)` | 26 | app.css:1643, app.css:2599, app.css:2637 | DS-TOK-85 `--bp-tablet` |
| `media (max-width: 1279px)` | 9 | app.css:629, app.css:2367, app.css:3720 | DS-TOK-86 `--bp-desk` |
| `media (min-width: 1440px)` | 5 | app.css:1244, app.css:1275, app.css:4601 | DS-TOK-87 `--bp-seat` |
| `media (prefers-reduced-motion: reduce)` | 4 | app.css:2881, app.css:4857, app.css:8532 | not a width |
| `media not all and (max-width: 1279px)` | 2 | app.css:5765, app.css:5844 | DS-TOK-86 `--bp-desk` |
| `media (min-width: 1279px)` | 2 | app.css:11718, app.css:12696 | DS-TOK-86 `--bp-desk` |
| `media (900px < width <= 1279px)` | 1 | app.css:5853 | DS-TOK-85 `--bp-tablet` |
| `container deck (max-width: 1000px)` | 1 | app.css:7892 | container query (component-local, BOARDS/DECK) |
| `container deck (max-width: 640px)` | 1 | app.css:7896 | DS-TOK-84 `--bp-mobile` |
| `container board (max-width: 1350px)` | 1 | app.css:11762 | container query (component-local, BOARDS/DECK) |
| `container board` | 1 | app.css:12317 | container query (component-local, BOARDS/DECK) |
| `media (max-width: 1180px)` | 1 | app.css:12903 | page-local: drift |
| `media (max-width: 760px)` | 1 | app.css:12907 | page-local: drift |

Also in JS: `matchMedia('(max-width: 700px)')` in `projectsboard.js` (drift), `matchMedia('(min-width: 1440px)')` in `dock.js` and the pre-paint hook (DS-TOK-87 `--bp-seat`), and the computed seat line `panels × max(380, dock-w or 550) ≤ innerWidth − rail − 40 − 836` (DS-TOK-92 `--content-floor`).


### Phantom tokens (referenced, never declared)

- `--shadow-2`: 1 reference(s), first at `app.css:6335`, falls back to `0 6px 20px color-mix(in oklab, var(--ink` → DS-TOK-73 `--shadow`. Defect, not to copy.
- `--focus`: 2 reference(s), first at `app.css:10542`, falls back to `currentColor` → DS-TOK-77 `--focus-ring`. Defect, not to copy.
- `--text-1`: 3 reference(s), first at `app.css:10764`, no fallback, so the declaration is invalid at computed time (the intent reads as --text) → DS-TOK-6 `--text`. Defect, not to copy.

Set at runtime and so not phantoms: `--rail-w` (pre-paint hook and portal.js:633), `--dock-w` (pre-paint and dock.js:315), `--chrome-h` (portal.js:717), `--catw` and `--catbar-h` (board.js:1292, 1323), `--tg-w`, `--tg-h`, `--tg-pt`, `--tg-px`, `--tg-pb` (inline from taskgraph.js:619), `--detail-label` (inline in client-portal pages).

### Declared and never used

37 declared names have no `var()` reference in any stylesheet, script or page of the app (the client-portal monthly report uses `--s-9`): `--paper-cream`, `--bp-mobile`, `--bp-tablet`, `--bp-desk`, `--accent-hover`, `--accent-soft`, `--brand-ring`, `--brand-ink`, `--gradient-brand`, `--gradient-brand-start`, `--gradient-brand-end`, `--blue`, `--blue-soft`, `--green`, `--green-soft`, `--orange`, `--orange-soft`, `--rose`, `--rose-soft`, `--text-num-xs`, `--fs-body`, `--fs-h2`, `--fs-display`, `--s-9`, `--pad-y`, `--space-7`, `--radius`, `--radius-xl`, `--dur-slow`, `--dur-3`, `--sidebar-w`, `--sidebar-collapsed-w`, `--topbar-h`, `--footer-h`, `--content-max`, `--grad-footer`, `--aip-dock`. Some are kept as canonical anyway because the build will use them (`--bp-mobile`, `--bp-tablet`, `--bp-desk`, whose numbers the media queries repeat). The Hub marketing and Hub layout names (`--fs-display`, `--grad-footer`, `--sidebar-w` and the like) came in with the verbatim DS snapshot and are retired. The rest are listed as drift under their canonical token.

## Rulings, decided

Each was a place where the mockup might be deliberate. All twelve are ruled (26 September 2026, the `DR` triage on #297's map) and written into the token entries above. Cite the `DR` id, never the lane label.

- **R-TOK-1** Dark faint text: `--ink-faint` (46%, 182 uses) and `--text-muted` (55%, 266 uses) are the same in light and split in dark (ΔE00 7.9). Proposed: one token at 55%. See drift sheet. **Ruled, DR-10 (decided):** `--ink-faint` folds into `--text-muted` at 55% in both themes (R-TOK-1; no duplicates).
- **R-TOK-2** Accent washes at 4, 6, 8 and 14%. Proposed: one `--accent-wash` at 8%. **Ruled, DR-11 (decided):** one `--accent-wash` at 8% (R-TOK-2; no duplicates).
- **R-TOK-3** Section heads (28) are larger than the page title (24). Proposed: keep, section heads lead the page body; or swap so the title leads. **Ruled, DR-12 (decided):** keep section head 28 over page title 24, as drawn (C109; R-TOK-3).
- **R-TOK-4** `--fs-lead` 18px beside `--text-h2` 20px. Proposed: fold 18 into 20. **Ruled, DR-13 (decided):** `--fs-lead` folds into `--text-h2` 20 (R53).
- **R-TOK-5** Reading line heights 1.45, 1.5, 1.6 and 1.7 beside 1.55. Proposed: one `--leading-normal` 1.55. **Ruled, DR-14 (decided):** one reading line height, 1.55 (R53).
- **R-TOK-6** `--dur` 180ms and `--dur-1` 220ms are 40ms apart and both used. Proposed: keep both (180 for colour, 220 for movement), or fold to 200. **Ruled, DR-15 (decided):** keep `--dur` 180 (colour) and `--dur-1` 220 (movement) (R-TOK-6).
- **R-TOK-7** Headline and number roles set in Funnel Sans instead of Display (five styles). Proposed: Display for every number and headline role. **Ruled, DR-6 (decided):** five Sans number/headline roles to Display (R53). Task hero mono 20 kept as a named style (DIRECTION, task page as drawn).
- **R-TOK-8** The portal hero's 128px number and 49.6px name exceed the display scale. Proposed: keep as a hero-only variant owned by the hero component. **Ruled, DR-7 (decided):** hero-only exceptions owned by DS-COMP-31 (both lanes; R53 named exceptions).
- **R-TOK-9** New half steps `--s-0-5` 2px and `--s-1-5` 6px for the dense UI (258 literal uses). Proposed: add both. **Ruled, DR-16 (decided):** add `--s-0-5` 2px and `--s-1-5` 6px (R-TOK-9).
- **R-TOK-10** The z-index ladder (nine proposed layers) replaces 17 literal values. Proposed: adopt as listed. **Ruled, DR-17 (decided):** adopt the nine-layer z ladder (R-TOK-10; CD-1 mechanism).
- **R-TOK-11** `--rail-bg` is ΔE00 1.6 from `--bg` in light (under the near-duplicate line). Proposed: keep; the rail reads as its own plane, which the owner likes. **Ruled, DR-18 (decided):** keep `--rail-bg` as its own plane, as drawn (R-TOK-11).
- **R-TOK-12** `.sb` panel at z 72 sits two above the AI panel (70). Proposed: fold into --z-panel unless the two can be open together. **Ruled, DR-19 (decided):** no `.sb` layer. The dead fixed-drawer rule is not built (TASK-PAGE defect 43).

## Old ids to new ids

| Old id (SHELL.md section 1) | New id | Note |
|---|---|---|
| DS-C1 | DS-TOK-1 `--bg` |  |
| DS-C2 | DS-TOK-2 `--surface` |  |
| DS-C3 | DS-TOK-3 `--surface-2` |  |
| DS-C4 | DS-TOK-4 `--surface-3` |  |
| DS-C5 | DS-TOK-6 `--text` |  |
| DS-C6 | DS-TOK-7 `--text-2` |  |
| DS-C7 | DS-TOK-8 `--text-muted` |  |
| DS-C8 | DS-TOK-9 `--text-dim` |  |
| DS-C9 | DS-TOK-10 `--border` |  |
| DS-C10 | DS-TOK-11 `--border-strong` |  |
| DS-C11 | DS-TOK-12 `--rule` |  |
| DS-C12 | DS-TOK-13 `--accent` |  |
| DS-C13 | DS-TOK-16 `--on-dark` | `--accent-ink` is an alias of --on-dark |
| DS-C14 | DS-TOK-15 `--accent-ring` |  |
| DS-C15 | DS-TOK-21 `--info`, DS-TOK-22 `--success`, DS-TOK-23 `--warning`, DS-TOK-24 `--danger` | four ids, one per status |
| DS-C16 | DS-TOK-5 `--rail-bg` |  |
| DS-C17 | DS-TOK-19 `--app-chrome` |  |
| DS-C18 | DS-TOK-16 `--on-dark` | `--face-chrome-ink`/`--app-ink` are aliases of --on-dark |
| DS-C19 | DS-TOK-20 `--client-brand` |  |
| DS-C20 | DS-TOK-18 `--void` | `--void-deep` folds into --void; `--on-dark` and `--on-dark-muted` are DS-TOK-16 `--on-dark`, DS-TOK-17 `--on-dark-muted` |
| DS-C21 | - | `--btn-fill` → DS-TOK-6 `--text`, `--btn-text` → DS-TOK-1 `--bg`, `--btn-hover` → DS-TOK-13 `--accent` (button colours become component tokens in PRIMITIVES) |
| DS-C22 | DS-TOK-27 `--hero-paint` |  |
| DS-C23 | - | retired: Hub marketing gradients, no call site in the app |
| DS-C24 | - | excluded: mockup triage overlay, not a product token |
| DS-T1 | DS-TOK-117 `--type-body` |  |
| DS-T2 | DS-TOK-124 `--type-data` |  |
| DS-T3 | DS-TOK-120 `--type-small` |  |
| DS-T4 | DS-TOK-126 `--type-eyebrow` |  |
| DS-T5 | DS-TOK-118 `--type-body-strong` |  |
| DS-T6 | DS-TOK-127 `--type-tag` |  |
| DS-T7 | DS-TOK-126 `--type-eyebrow` | lh 1.55 → 1.4 |
| DS-T8 | DS-TOK-119 `--type-card-title` |  |
| DS-T9 | DS-TOK-123 `--type-button` |  |
| DS-T10 | DS-TOK-128 `--type-chip` |  |
| DS-T11 | DS-TOK-118 `--type-body-strong` | weight 700 → 500 (no 700 face) |
| DS-T12 | DS-TOK-113 `--type-num-lg` |  |
| DS-T13 | DS-TOK-108 `--type-section` |  |
| DS-T14 | DS-TOK-109 `--type-title` |  |
| DS-T15 | DS-TOK-112 `--type-rail-label` |  |
| DS-T16 | DS-TOK-128 `--type-chip` | 10.88 300 → 11 400 |
| DS-T17 | DS-TOK-129 `--type-badge` |  |
| DS-T (families, scale, line heights, tracking, weights) | DS-TOK-28 `--font-display`, DS-TOK-29 `--font-sans`, DS-TOK-30 `--font-mono`; sizes DS-TOK-35 `--text-display` to DS-TOK-48 `--text-num-sm`; line heights DS-TOK-49 `--leading-none` to DS-TOK-52 `--leading-normal`; tracking DS-TOK-53 `--tracking-display` to DS-TOK-56 `--tracking-caps`; weights DS-TOK-31 `--weight-light` to DS-TOK-34 `--weight-semibold` | the declared scale, one id per step |
| DS-S | DS-TOK-57 `--s-0-5` to DS-TOK-68 `--pad-x` | `--space-N` are aliases |
| DS-R | DS-TOK-69 `--radius-none`, DS-TOK-70 `--radius-pill`, DS-TOK-71 `--radius-round` | |
| DS-E | DS-TOK-72 `--shadow-sm` to DS-TOK-77 `--focus-ring` | |
| DS-M | DS-TOK-78 `--ease` to DS-TOK-83 `--dur-flash` | `body.aa-shifting` 500ms (portal.js:141-147) is JS, noted under --dur-flash |
| DS-I1 | DS-TOK-102 `--icon-xs`, DS-TOK-103 `--icon-sm`, DS-TOK-104 `--icon-md`, DS-TOK-105 `--icon-lg` | the icon font itself (Flaticon UIcons regular-rounded 2.6.0) is an asset, not a token (PRIMITIVES lane) |
| DS-I2 | DS-TOK-106 `--icon-door` (size only) | the door-mark vocabulary is a component: PRIMITIVES lane |
| DS-I3 | DS-TOK-106 `--icon-door` | .85em and 62% currentColor |
| DS-I4 | none | logos are assets (SIDEBAR lane) |
| DS-I5 | none | "no emoji, ever" is a law, kept in the component catalogue |

## Handed to other lanes

- **SIDEBAR**: the rail dimensions and behaviour (`--rail-w` 224, `--rail-w-collapsed` 56, drag, the pre-paint hook), the app-strip ink ladder (twelve recipes), `--rail-bg` as the rail plane, logo assets (DS-I4).
- **PRIMITIVES**: button colour tokens (`--btn-*`) and the component-local `--fz`/`--pad-x` in `hub-ds/buttons.css`; the `outline: none` rules (26) that need a matching focus style; inset-shadow accent bars and rings; the icon font and door-mark vocabulary (DS-I1, DS-I2); `.chip` versus Hub `.u-pill`.
- **COMPOSITES**: hero cover recipes (white 12 to 32%, paper 22 and 62%), the locate flash keyframe, board-local z-index 11 and 12, container queries (`deck`, `board`), the portal hero outsizes (DR-7).

## Appendix: usages by inventory id

Element ids from `docs/mockup-inventory/` rows that name the token or one of its aliases, grouped by page file. Text styles are matched from the family and size each row cites. Tokens with no inventory row (61): `--on-dark-muted`, `--scrim`, `--accent-wash`, `--font-display`, `--font-sans`, `--font-mono`, `--weight-light`, `--weight-regular`, `--weight-medium`, `--weight-semibold`, `--fs-title`, `--text-h1`, `--text-body-lg`, `--text-body`, `--text-label`, `--text-overline`, `--text-micro`, `--text-num-lg`, `--leading-none`, `--lh-title`, `--lh-body`, `--leading-normal`, `--tracking-display`, `--tracking-tight`, `--tracking-caps`, `--s-0-5`, `--s-1`, `--s-1-5`, `--s-6`, `--pad-x`, `--radius-none`, `--radius-pill`, `--radius-round`, `--shadow`, `--shadow-lg`, `--shadow-edge`, `--dur-fast`, `--dur`, `--dur-flash`, `--bp-mobile`, `--bp-tablet`, `--bp-desk`, `--bp-seat`, `--rail-w-collapsed`, `--app-strip`, `--dock-w`, `--content-floor`, `--z-raised`, `--z-sticky`, `--z-popover`, `--z-dock-rail`, `--z-backdrop`, `--z-nav`, `--z-chrome-lift`, `--z-panel`, `--z-tooltip`, `--icon-xs`, `--icon-sm`, `--icon-md`, `--icon-lg`, `--icon-door`; they are used in the CSS (see CSS refs) but no inventory row names them.

- DS-TOK-1 `--bg`: **SHELL** SH-18 · **TASKS** DT-10 · **WORKBENCH** SH-01, SH-16, CN-M03, CNX-M03, CNX-M09, TL-M06, OB-M03, FM-M06, SS-M05, SI-M06, SI-M12, SI-M15, SIR-M06, SIR-M10, SIR-M13, SIR-M16, GA-M03, MA-M03, TS-M02, LR-M05, CL-M06, EM-M06, FN-M05, RV-M05, WP-M06 · **PORTAL** PLK-06, PH-12, PP-10, PLV-07 · **DOCK** CL-05, CL-07, CR-01, CR-07, CR-20, CR-23, CR-28, DC-01, DC-14, AI-09, AI-11 · **BOARDS** B-05, B-07, B-08, B-20, B-24, B-26, P-30, P-33, L-05, C-24, S-01, S-03 · **AGENCY** AG-P3, AG-C14
- DS-TOK-2 `--surface`: **SHELL** SH-7, SH-25, SH-55 · **DOCK** DK-02, CL-07, CR-05, PJ-03, AI-10 · **TASKS** DP-08, DP-16, DP-18, DT-21, TG-05 · **BOARDS** B-01, B-06, B-10, C-20, C-41, G-05 · **WORKBENCH** SH-10, SH-16, SH-18, CN-M03, CNX-M03, CNX-M09, TL-M06, OB-M03, FM-M06, SS-M05, SI-M06, SI-M12, SI-M15, SIR-M06, SIR-M10, SIR-M13, SIR-M16, GA-M03, MA-M03, TS-M02, LR-M05, CL-M06, EM-M06, FN-M05, RV-M05, WP-M06, WPO-M06 · **AGENCY** AG-K4, AG-K14, AG-A6 · **CLIENT** BR-07, BR-17, BR-29, BR-31, BR-33, BR-52, VO-02 · **PORTAL** PP-10, PG-04, PLD-03, PB-04, PB-06, PB-07
- DS-TOK-3 `--surface-2`: **SHELL** SH-4, SH-55 · **DOCK** TM-01, AI-09 · **TASKS** DP-18, DP-27, DT-21, TP-10, TG-05 · **BOARDS** B-03, B-04, B-20, P-65, C-25, C-42 · **WORKBENCH** SH-18, SH-20, SH-21, CNX-M22, SI-M11, SI-M13, SI-M14, SIR-M12, SIR-M14, SIR-M15, MA-W03, WB-05 · **AGENCY** AG-K17, AG-P17, AG-A6, AG-A7, AG-A10, AG-A12 · **CLIENT** BR-12, BR-21, BR-31, BR-39, BR-44, RC-06, WK-22, AC-02, AC-10, AC-11 · **PORTAL** PP-20, PLV-05, PC-05, PC-06, PB-07
- DS-TOK-4 `--surface-3`: **WORKBENCH** SH-22 · **CLIENT** WK-11
- DS-TOK-5 `--rail-bg`: **SHELL** SH-1, SH-25 · **DOCK** DK-01 · **PORTAL** PLV-07
- DS-TOK-6 `--text`: **SHELL** SH-1, SH-4, SH-7, SH-18, SH-23, SH-25, SH-2 · **DOCK** DK-02, DK-08, DK-13, CL-05, CL-07, CL-13, CL-14, CR-06, CR-28, CR-29, DC-04, DC-16, BM-02, PJ-05, PJ-08, TM-02, NT-02, NT-03, NT-04, NT-06, AI-07, CR-07, CR-11, CR-20, PJ-03, AI-09 · **TASKS** DP-01, DP-07, DP-08, DP-11, DP-14, DP-15, DP-18, DP-27, DP-28, DP-34, DT-03, DT-10, DT-12, DT-16, DT-21, TP-01, TP-10, TP-11, TG-02 · **BOARDS** B-01, B-04, B-06, B-07, B-09, B-10, B-15, B-21, P-01, P-05, P-23, P-32, P-33, L-05, C-21, S-05, B-08, B-20, P-11, P-36, P-62, C-24, S-03 · **WORKBENCH** SH-01, SH-06, SH-11, SH-16, CN-M03, CN-M04, CN-M05, CN-M06, CN-M07, CN-M08, CN-M09, CN-M10, CN-M11, CN-M12, CN-M13, CN-M14, CN-M15, CN-M16, CN-M17, CN-M18, CN-M19, CN-M20, CN-M21, CNX-M03, CNX-M04, CNX-M05, CNX-M06, CNX-M09, CNX-M10, CNX-M11, CNX-M12, CNX-M13, CNX-M14, CNX-M15, CNX-M16, CNX-M17, CNX-M18, CNX-M19, CNX-M20, CNX-M21, CNX-M22, CNX-M23, CNX-M24, CNX-M25, CNX-M26, TL-M05, TL-M06, TL-M07, TL-M09, OB-M03, OB-M04, OB-M07, OB-M08, FM-M05, FM-M06, FM-M07, FM-M09, SS-M05, SS-M06, SS-M08, SS-M09, SS-M10, SI-M05, SI-M06, SI-M07, SI-M09, SI-M10, SI-M11, SI-M12, SI-M13, SI-M14, SI-M15, SIR-M05, SIR-M06, SIR-M07, SIR-M09, SIR-M10, SIR-M12, SIR-M13, SIR-M14, SIR-M15, SIR-M16, GA-M03, GA-M04, GA-M07, MA-M03, MA-M04, MA-M07, MA-M08, TS-M02, TS-M03, TS-M06, LR-M05, LR-M06, LR-M08, CL-M05, CL-M06, CL-M07, CL-M09, CL-M10, EM-M05, EM-M06, EM-M07, EM-M09, EM-M12, FN-M05, FN-M06, FN-M08, FN-M09, RV-M05, RV-M06, RV-M08, WP-M05, WP-M06, WP-M07, WP-M09, WP-M10, WPO-M05, WPO-M06, WPO-M07, WPO-M09, WPO-M10, SH-04, SH-12, SH-21, SH-22, SS-W02, GA-W04 · **AGENCY** AG-K14, AG-P24i, AG-P3, AG-E8, AG-C14, AG-C46 · **CLIENT** BR-08, BR-09, BR-17, BR-04, BR-12, BR-39, BR-52, RC-06, MO-07, AC-18, CL-D4 · **PORTAL** PP-18, PH-11, PH-12, PP-01, PP-12, PAI-02, PB-04, PB-06, PB-07
- DS-TOK-7 `--text-2`: **SHELL** SH-4, SH-18 · **DOCK** CL-07, CR-05, CR-07, CR-24, CR-26, DC-05, DC-18, DC-20, PJ-07, NT-02, NT-08, AI-10 · **TASKS** DP-31, DT-05, DN-04, TT-01, DP-14, DT-06, DT-12, DA-08, TT-06, TG-02 · **BOARDS** B-04, B-06, B-07, B-12, P-24, P-25, P-26, P-31, P-36, C-20, S-05, G-05 · **WORKBENCH** SH-01, SH-21, SH-23, SH-25, CN-W02, CNX-M07, CNX-M08, TL-M08, OB-M05, FM-M08, SS-M07, SI-W03, SI-M08, SI-M16, SI-M17, SIR-M08, SIR-M17, SIR-M18, GA-M05, GA-M11, MA-M05, TS-M04, LR-M07, CL-M08, EM-M08, FN-M07, RV-M07, WP-M08, WPO-M08 · **AGENCY** AG-K13, AG-K14, AG-K18, AG-C15, AG-C16, AG-K16, AG-P24a · **CLIENT** BR-46, RC-05, RC-06, WK-06, MO-12, DSY-04, DSY-06, DSY-11, VO-02, AC-02, AC-07 · **PORTAL** PH-07, PH-15, PH-17, PW-02, PT-07, PP-10, PP-13, PP-14, PG-04, PLK-03, PAC-05, PC-05, PC-11, PB-04, PB-06, PB-07, PB-09
- DS-TOK-8 `--text-muted`: **DOCK** CL-07, CL-08, CL-11, CL-13, CR-03, CR-04, CR-22, CR-23, CR-24, CR-30, CR-31, DC-07, DC-12, DC-13, DC-15, DC-17, DC-19, DC-21, BM-02, BM-09, PJ-05, PJ-11, PJ-12, NT-03, NT-06, NT-08, AI-03, AI-05, AI-09, DK-02, DK-06, DK-08, DK-09, DK-11, DK-13, CL-02, CL-03, CL-06, CR-10, CR-12, CR-25, CR-28, CR-29, DC-02, DC-06, DC-08, DC-09, BM-03, BM-07, PJ-03, PJ-04, NT-05 · **TASKS** DP-11, DP-32, DP-33, DT-04, DT-12, DT-16, DT-19, DN-02, TP-02, TP-03, TP-07, TM-02, DP-02, DP-03, DP-04, DP-05, DP-07, DP-09, DP-10, DP-14, DP-29, DP-30, DP-31, DA-10, TP-05, TP-09 · **BOARDS** B-03, B-10, B-21, B-22, B-23, P-33, P-40, P-42, C-15, C-23, S-04, V-01, B-01, B-05, B-15, P-07, P-20, P-47, C-24, C-42, S-02, S-05, G-01, G-04, V-05 · **WORKBENCH** SH-11, SH-16, SH-18, SH-19, SH-20, CN-W03, CN-W05, CN-M01, CN-M02, CNX-M01, CNX-M02, TL-M01, TL-M02, TL-M03, TL-M04, TL-M10, OB-M01, OB-M02, OB-M06, OB-M09, FM-M01, FM-M02, FM-M03, FM-M04, FM-M10, FM-M11, FM-M12, FM-M13, FM-M14, SS-M01, SS-M02, SS-M03, SS-M04, SS-M11, SI-M01, SI-M02, SI-M03, SI-M04, SI-M18, SIR-M01, SIR-M02, SIR-M03, SIR-M04, SIR-M19, GA-M01, GA-M02, GA-M06, GA-M08, GA-M09, GA-M10, MA-M01, MA-M02, MA-M06, TS-M01, TS-M05, LR-M01, LR-M02, LR-M03, LR-M04, LR-M09, CL-M01, CL-M02, CL-M03, CL-M04, CL-M11, EM-M01, EM-M02, EM-M03, EM-M04, EM-M10, EM-M11, EM-M13, FN-M01, FN-M02, FN-M03, FN-M04, FN-M10, RV-M01, RV-M02, RV-M03, RV-M04, RV-M09, WP-M01, WP-M02, WP-M03, WP-M04, WPO-M01, WPO-M02, WPO-M03, WPO-M04, SH-03, SH-06, SH-10, SH-12, SH-13, SH-14, SH-15, SH-17, SH-25 · **AGENCY** AG-K1, AG-K3, AG-K6, AG-K7, AG-K12, AG-P24i, AG-E12, AG-C14 · **CLIENT** BR-34, BR-07, BR-08, BR-09, BR-11, BR-14, BR-17, BR-26, BR-27, BR-30, BR-31, BR-35, BR-39, BR-40, BR-42, BR-43, BR-48, BR-51, BR-52, BR-53, BR-54, RC-04, RC-06, RC-07, WK-04, WK-12, WK-13, WK-16, WK-20, MO-03, MO-06, MO-07, MO-09, MO-11, MO-13, BD-04, BD-05, DSY-05, DSY-07, DSY-12, VO-02, VO-04, VO-08, AC-10, AC-11, AC-12, AC-16, AC-19 · **PORTAL** PAC-03, PH-07, PH-10, PH-11, PH-13, PH-16, PM-04, PT-03, PT-05, PT-06, PT-07, PP-05, PP-06, PP-09, PP-11, PP-13, PP-14, PP-18, PP-19, PG-03, PLB-06, PLB-07, PLB-08, PLV-03, PLV-05, PLV-06, PLD-03, PLK-06, PC-08, PC-09, PC-10, PC-11, PB-04, PB-06, PB-08, PB-09 · **SHELL** SH-7, SH-22, SH-25
- DS-TOK-9 `--text-dim`: **DOCK** CR-05, CR-12, AI-07 · **BOARDS** B-10, P-20, P-23, C-43 · **PORTAL** PH-10
- DS-TOK-10 `--border`: **SHELL** SH-1, SH-18, SH-25, SH-55 · **DOCK** DK-01, DK-10, CL-05, CR-05, CR-21, CR-23, CR-24, CR-28, DC-01, DC-14, TM-01, NT-04, NT-06, AI-04, AI-09, AI-10, AI-11 · **TASKS** DT-09, DA-02, DA-05, TA-01, TG-04, TG-05, TG-06, DP-18, DP-20, DP-26, DP-34, DT-21, TG-02 · **BOARDS** B-01, B-06, B-14, B-17, B-19, B-21, B-22, B-24, P-26, P-33, C-13, C-24, C-41, S-03, S-05, G-01, G-05 · **WORKBENCH** SH-01, SH-06, SH-16, SH-17, SH-18, SH-20, CNX-M09, OB-M07, SS-M08, SI-M11, SI-M12, SI-M13, SI-M14, SIR-M12, SIR-M13, SIR-M14, SIR-M15, FN-M08, SH-11, SH-23 · **AGENCY** AG-K10, AG-K14, AG-A6, AG-K5 · **CLIENT** BR-01, BR-21, BR-31, BR-44, BR-46, RC-01, RC-05, RC-06, RC-07, RC-09, MO-13, TR-08, BD-03, BD-05, BD-06, DSY-08, VO-02, VO-06, VO-08, AC-02, AC-10, AC-16, AC-17, BR-08 · **PORTAL** PH-11, PH-13, PH-15, PH-16, PH-19, PW-02, PT-05, PT-07, PP-05, PP-10, PP-12, PP-14, PP-20, PG-03, PG-04, PLB-07, PLB-08, PLV-07, PLD-03, PLK-06, PC-05, PC-06, PC-09, PC-11, PB-04, PB-06, PB-07
- DS-TOK-11 `--border-strong`: **SHELL** SH-23, SH-25, SH-60 · **DOCK** DK-04, CL-07, CR-01, CR-07, CR-12, CR-28, DC-04, PJ-03, PJ-07 · **TASKS** DP-08, DP-16, DP-18, DP-20, DT-02, DA-07, TG-02, TG-05 · **BOARDS** B-05, B-06, B-07, B-15, P-12, P-30, L-05, C-20, S-01 · **WORKBENCH** SH-10, SH-12, SH-19 · **AGENCY** AG-K4, AG-A5, AG-A7, AG-A9, AG-A10 · **CLIENT** BR-07, BR-17, BR-20, BR-29, BR-33, BR-41, BR-44, BR-52, DSY-06, DSY-09 · **PORTAL** PH-10
- DS-TOK-12 `--rule`: **TASKS** DT-19 · **WORKBENCH** SH-10, SH-12, SH-18, SH-20, SH-23 · **AGENCY** AG-K4 · **CLIENT** BR-17, BR-27, BR-45 · **PORTAL** PH-08, PT-03
- DS-TOK-13 `--accent`: **SHELL** SH-6, SH-13, SH-19, SH-25, SH-26 · **DOCK** DK-02, DK-05, DK-09, DK-14, CL-01, CL-03, CL-08, CL-11, CR-02, CR-04, CR-05, CR-22, CR-23, CR-24, CR-26, CR-28, CR-29, DC-01, DC-07, DC-16, DC-20, BM-02, PJ-02, PJ-08, TM-01, TM-02, NT-03, NT-06, AI-03, AI-05 · **TASKS** DP-02, DP-03, DP-04, DP-05, DP-08, DP-09, DP-10, DP-13, DP-16, DP-18, DP-20b, DP-20d, DP-28, DP-29, DP-30, DP-34, DP-35, DT-02, DT-06, DT-09, DT-16, DT-17, DT-19, DA-02, DA-03, TP-05, TT-06, TG-02, TG-03, TG-05, TG-06, DT-21 · **BOARDS** B-01, B-03, B-06, B-07, B-09, B-10, B-16, B-17, B-20, P-30, P-31, P-36, S-03, M-05, G-05 · **WORKBENCH** SH-01, SH-13, SH-16, SH-25, SS-W02, SI-W01, GA-W04, CL-W04, FN-W02 · **AGENCY** AG-K7, AG-K10, AG-K13, AG-K14, AG-K16, AG-P17, AG-P24a, AG-P24b, AG-E8, AG-E12 · **CLIENT** BR-35, BR-41, BR-43, BR-44, BR-46, BR-51, BR-55, RC-01, RC-09, WK-03, WK-04, WK-12, WK-23, MO-07, MO-13, DSY-11, DSY-12, VO-02, VO-06, AC-02, AC-10, AC-16 · **PORTAL** PH-10, PH-14, PH-15, PW-02, PT-08, PP-05, PP-19, PP-20, PG-04, PLK-03, PLK-06, PC-06, PC-09, PB-04, PB-06, PB-07, PH-12
- DS-TOK-14 `--hover-accent`: **TASKS** DN-04
- DS-TOK-15 `--accent-ring`: **TASKS** DT-10
- DS-TOK-16 `--on-dark`: **DOCK** DK-03, DK-05 · **WORKBENCH** SH-21 · **SHELL** SH-10 · **CLIENT** BR-01, BR-02 · **PORTAL** PH-03
- DS-TOK-18 `--void`: **DOCK** DK-03, D-12
- DS-TOK-19 `--app-chrome`: **SHELL** SH-10
- DS-TOK-20 `--client-brand`: **SHELL** SH-10 · **PORTAL** PF-06
- DS-TOK-21 `--info`: **SHELL** SH-41 · **BOARDS** G-01 · **WORKBENCH** SH-06, SH-23, TL-W06, SS-W04, SI-W01 · **AGENCY** AG-K2 · **CLIENT** BR-28, WK-20 · **PORTAL** PH-02
- DS-TOK-22 `--success`: **TASKS** DA-02, DA-05 · **WORKBENCH** SH-11, CN-W04, CN-W09, TL-W04, SI-W01, SI-W07, TS-W05, LR-W03, LR-W05, EM-W04, FN-W02, RV-W05, WP-W03, D18 · **CLIENT** BR-30, BR-37, RC-08, WK-09, WK-10, WK-11, WK-15, WK-20, MO-08, MO-09, VO-02, AC-04, AC-07, AC-13, AC-14 · **PORTAL** PH-13, PT-07, PP-13, PP-14, PP-15, PLV-03
- DS-TOK-23 `--warning`: **DOCK** CR-21 · **TASKS** DA-02, DA-07, TP-04, TG-03, TG-05, TG-06 · **BOARDS** C-15, C-31 · **WORKBENCH** SH-17, SH-23, SH-25, CN-W04, CN-W05, CN-W09, TL-W04, FM-W03, FM-W07, SI-W01, SI-W07, TS-W03, TS-W04, LR-W03, FN-W04, WP-W03 · **CLIENT** BR-03, BR-08, BR-30, RC-02, RC-06, WK-04, WK-05, WK-07, WK-15, WK-19, MO-08, MO-09, VO-02, VO-08, AC-02, AC-03, AC-04, AC-07 · **PORTAL** PH-13, PH-16, PT-07, PP-13, PP-14, PP-15
- DS-TOK-24 `--danger`: **DOCK** DK-06, CR-24, DC-08, BM-03, PJ-10, PJ-11, D-17 · **TASKS** DT-09, DT-12, DA-02, DA-04, DA-09, T6, T17 · **BOARDS** P-25, P-28 · **WORKBENCH** SH-11, SH-23, CN-W04, CN-W09, FM-W01, FM-W03, SI-W01, SI-W04, SI-W09, LR-W03, CL-W03, FN-W02, RV-W05 · **CLIENT** BR-08, BR-30, BR-37, MO-08, VO-05, AC-04 · **PORTAL** PH-13, PT-07, PLV-06
- DS-TOK-27 `--hero-paint`: **CLIENT** BR-01 · **PORTAL** PH-03
- DS-TOK-35 `--text-display`: **TASKS** TP-06
- DS-TOK-38 `--text-h2`: **TASKS** TA-01 · **WORKBENCH** SH-10 · **AGENCY** AG-K4
- DS-TOK-39 `--text-h3`: **TASKS** TA-01
- DS-TOK-42 `--text-sm`: **WORKBENCH** SH-11, SH-17, SH-18, SH-25
- DS-TOK-47 `--text-num-md`: **WORKBENCH** SH-11 · **AGENCY** AG-K5
- DS-TOK-48 `--text-num-sm`: **WORKBENCH** SH-23
- DS-TOK-55 `--tracking-label`: **DOCK** CL-06
- DS-TOK-60 `--s-2`: **BOARDS** B-22, P-41, L-05
- DS-TOK-61 `--s-3`: **SHELL** SH-7 · **TASKS** DA-05, DA-07 · **BOARDS** B-05, B-15, B-19, L-05, S-01, S-03
- DS-TOK-62 `--s-4`: **BOARDS** P-48, C-41, S-01, G-01, G-03, G-05
- DS-TOK-63 `--s-5`: **SHELL** SH-7, SH-9, SH-50 · **BOARDS** B-22, B-23, C-41
- DS-TOK-65 `--s-7`: **BOARDS** B-23 · **PORTAL** PH-06
- DS-TOK-66 `--s-8`: **SHELL** SH-50
- DS-TOK-67 `--s-9`: **SHELL** SH-50
- DS-TOK-72 `--shadow-sm`: **SHELL** SH-25 · **DOCK** DK-01
- DS-TOK-75 `--shadow-overlay`: **BOARDS** B-05
- DS-TOK-77 `--focus-ring`: **WORKBENCH** SH-18
- DS-TOK-78 `--ease`: **SHELL** SH-6
- DS-TOK-81 `--dur-1`: **TASKS** DP-13
- DS-TOK-82 `--dur-2`: **SHELL** SH-19
- DS-TOK-88 `--rail-w`: **SHELL** SH-7
- DS-TOK-107 `--type-display`: **SHELL** DS-T12, DS-K14, SH-52 · **AGENCY** AG-K9 · **CLIENT** BR-01, WK-10, MO-03
- DS-TOK-108 `--type-section`: **SHELL** DS-T13, SH-42 · **AGENCY** AG-K3 · **CLIENT** BR-27, BD-04 · **PORTAL** PH-06, PLB-06
- DS-TOK-109 `--type-title`: **SHELL** DS-T14, SH-20 · **TASKS** TM-01 · **AGENCY** AG-P1 · **CLIENT** BR-38 · **PORTAL** PLB-05
- DS-TOK-110 `--type-heading`: **SHELL** SH-55 · **AGENCY** AG-E23 · **CLIENT** BR-29, BR-39, RC-03, AC-16 · **PORTAL** PH-17
- DS-TOK-111 `--type-subheading`: **DOCK** DK-08, AI-01 · **TASKS** DP-08
- DS-TOK-112 `--type-rail-label`: **SHELL** DS-T15, SH-3, SH-13 · **PORTAL** PH-13
- DS-TOK-115 `--type-num-sm`: **PORTAL** PH-04
- DS-TOK-116 `--type-body-lg`: **WORKBENCH** CN-M01, CNX-M01, TL-M01, OB-M01, FM-M01, SS-M01, SI-M01, SIR-M01, GA-M01, MA-M01, TS-M01, LR-M01, CL-M01, EM-M01, FN-M01, RV-M01, WP-M01, WPO-M01 · **CLIENT** BR-18 · **PORTAL** PH-05, PH-09, PH-12
- DS-TOK-117 `--type-body`: **SHELL** DS-T1, DS-K9, SH-4, SH-18 · **TASKS** DP-18, DP-20, DP-26, DP-27, DT-02, DT-03, TP-02, TP-04, TP-10, TT-01 · **WORKBENCH** CN-M08, CN-M09, CN-M10, CN-M11, CN-M12, CN-M13, CN-M14, CN-M15, CN-M16, CN-M17, CN-M18, CN-M19, CN-M20, CN-M21, CNX-M09, CNX-M13, CNX-M14, CNX-M15, CNX-M16, CNX-M17, CNX-M18, CNX-M19, CNX-M20, CNX-M21, CNX-M22, CNX-M23, CNX-M24, CNX-M25, CNX-M26, TL-M03, TL-M04, TL-M09, OB-M06, OB-M07, OB-M08, FM-M03, FM-M04, FM-M09, SS-M03, SS-M04, SS-M08, SS-M09, SI-M03, SI-M04, SI-M09, SI-M11, SI-M12, SI-M13, SI-M14, SIR-M03, SIR-M04, SIR-M09, SIR-M12, SIR-M13, SIR-M14, SIR-M15, GA-M06, GA-M07, MA-M06, MA-M07, TS-M05, TS-M06, LR-M03, LR-M04, LR-M08, CL-M03, CL-M04, CL-M09, EM-M03, EM-M04, EM-M09, FN-M03, FN-M04, FN-M08, FN-M09, RV-M03, RV-M04, RV-M08, WP-M03, WP-M04, WP-M09, WPO-M03, WPO-M04, WPO-M09 · **AGENCY** AG-K17, AG-P13 · **CLIENT** BR-45, WK-13, TR-06 · **PORTAL** PH-15, PT-06, PC-06, PB-06, PB-09
- DS-TOK-118 `--type-body-strong`: **SHELL** DS-T5, DS-T11 · **WORKBENCH** SH-01, CN-M04, CNX-M04 · **AGENCY** AG-P24a · **CLIENT** BR-31, WK-20, BD-03 · **PORTAL** PP-01, PG-04, PAC-03
- DS-TOK-119 `--type-card-title`: **SHELL** DS-T8, DS-K8 · **CLIENT** BR-13 · **PORTAL** PH-08, PP-15
- DS-TOK-120 `--type-small`: **SHELL** DS-T3, SH-10, SH-17 · **TASKS** DP-11, DT-21, TG-02 · **WORKBENCH** SS-M10, SI-M16, SI-M17, SIR-M17, SIR-M18, WP-M10, WPO-M10 · **AGENCY** AG-K13, AG-K14, AG-C46 · **CLIENT** BR-09, BR-26, BR-42, BR-47, BR-53, BR-54, RC-05, DSY-04, DSY-06, AC-02, AC-12 · **PORTAL** PP-12, PLV-05, PAC-05, PC-05, PB-04
- DS-TOK-121 `--type-small-strong`: **TASKS** DT-16 · **WORKBENCH** CN-M06, CNX-M11, SI-M15, SIR-M16 · **CLIENT** BR-52, MO-07, MO-13, BD-05 · **PORTAL** PP-18, PLB-07, PLD-03
- DS-TOK-122 `--type-caption`: **SHELL** DS-T9, SH-30 · **TASKS** DT-10, DA-10 · **WORKBENCH** SH-04, CN-M03, CN-M05, CNX-M03, CNX-M05, CNX-M06, CNX-M07, CNX-M08, CNX-M10, TL-M05, TL-M06, TL-M07, TL-M08, OB-M03, OB-M04, OB-M05, FM-M05, FM-M06, FM-M07, FM-M08, SS-M05, SS-M06, SS-M07, SI-M05, SI-M06, SI-M07, SI-M08, SI-M10, SIR-M05, SIR-M06, SIR-M07, SIR-M08, SIR-M10, GA-M03, GA-M04, GA-M05, GA-M11, MA-M03, MA-M04, MA-M05, MA-M08, TS-M02, TS-M03, TS-M04, LR-M05, LR-M06, LR-M07, CL-M05, CL-M06, CL-M07, CL-M08, CL-M10, EM-M05, EM-M06, EM-M07, EM-M08, EM-M12, FN-M05, FN-M06, FN-M07, RV-M05, RV-M06, RV-M07, WP-M05, WP-M06, WP-M07, WP-M08, WPO-M05, WPO-M06, WPO-M07, WPO-M08 · **AGENCY** AG-P4 · **CLIENT** BR-46, MO-06, AC-07 · **PORTAL** PP-10, PP-11
- DS-TOK-124 `--type-data`: **SHELL** DS-T2 · **TASKS** DP-29, DP-31, DP-32, DP-34, DP-35, DT-04, DT-06, DT-12, TP-01, TT-06, TM-04, D-09 · **BOARDS** P-25 · **AGENCY** D-A8 · **CLIENT** BR-55, RC-07, WK-12, DSY-08, AC-04 · **PORTAL** PH-10, PH-16, PC-08, PC-09, PB-07, PB-08
- DS-TOK-125 `--type-mono`: **WORKBENCH** CN-M02, CNX-M02 · **PORTAL** PLK-03
- DS-TOK-126 `--type-eyebrow`: **SHELL** DS-T4, DS-T7, DS-K5, DS-K7, SH-16 · **TASKS** DP-14, DP-15, TP-03 · **WORKBENCH** CN-M07, CNX-M12, TL-M02, TL-M10, OB-M09, FM-M02, FM-M10, FM-M11, FM-M12, FM-M13, FM-M14, SS-M02, SS-M11, SI-M02, SI-M18, SIR-M02, SIR-M11, SIR-M19, GA-M08, GA-M09, GA-M10, LR-M02, LR-M09, CL-M02, CL-M11, EM-M02, EM-M10, EM-M11, EM-M13, FN-M02, FN-M10, RV-M02, RV-M09, WP-M02, WPO-M02 · **AGENCY** AG-K6, AG-K12, AG-K18, AG-P3, AG-E12, AG-C14 · **CLIENT** BR-02, BR-08, BR-14, BR-30, BR-37, BR-40, BR-41, BR-43, BR-48, BR-51, RC-04, RC-06, WK-04, WK-11, DSY-05, DSY-11, VO-02, VO-06, VO-08, AC-01, AC-10 · **PORTAL** PH-03, PH-07, PH-11, PW-02, PM-04, PT-05, PT-07, PP-05, PP-09, PP-13, PG-03, PLV-03, PLV-07, PLK-06, PC-10, PC-11
- DS-TOK-127 `--type-tag`: **SHELL** DS-T6, DS-K12 · **TASKS** TM-02 · **WORKBENCH** OB-M02, GA-M02, MA-M02 · **CLIENT** BR-04, BR-34, RC-02, MO-09, DSY-07 · **PORTAL** PT-03, PLB-08
- DS-TOK-128 `--type-chip`: **SHELL** DS-T10, DS-T16, DS-K4, DS-K15, DS-K17, SH-14, SH-21, SH-22 · **TASKS** DP-28, DA-08, TP-11 · **WORKBENCH** SH-03 · **AGENCY** AG-K1, AG-K16 · **CLIENT** BR-03, WK-06, WK-09
- DS-TOK-129 `--type-badge`: **SHELL** DS-T17, SH-26 · **AGENCY** AG-E8, AG-S20 · **CLIENT** VO-04 · **PORTAL** PH-19, PP-14
