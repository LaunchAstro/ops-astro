# Open issues after slice one

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

Everything still open when slice one landed on `main` (#41 and #44, 25 September 2026). Since 28 September 2026 the roadmap is the one tracker: each issue below is closed as moved, and the roadmap ticket in its row is the source of truth. This page is a pointer list and gains no new rows. Severity: **P2** is a real defect or gap a person would notice, **P3** is minor.

31 moved: 4 at P2, 27 at P3. None was rated P1 (security, data loss, or the app not starting). Closed at landing: #45 and #46 (fixed in 9a8b84d).

## Governance and CI

| Issue                                                     | Severity | Title                                                                                    | Moved to      |
| --------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------- | ------------- |
| [#42](https://github.com/LaunchAstro/ops-astro/issues/42) | P3       | governance: an enforceable signal that each review of the head has completed             | roadmap CQ-13 |
| [#43](https://github.com/LaunchAstro/ops-astro/issues/43) | P3       | governance: reconcile which merges stay human                                            | roadmap CQ-13 |
| [#48](https://github.com/LaunchAstro/ops-astro/issues/48) | P3       | review-evidence-check: outcome lines inside an indented code block are read as fields    | roadmap CQ-13 |
| [#49](https://github.com/LaunchAstro/ops-astro/issues/49) | P3       | Independent recheck of the last two gate fixes in #41 (identity trailers, fence parsing) | roadmap CQ-13 |
| [#50](https://github.com/LaunchAstro/ops-astro/issues/50) | P3       | DCO check cannot evaluate a pull request of more than 250 commits                        | roadmap CQ-13 |
| [#51](https://github.com/LaunchAstro/ops-astro/issues/51) | P3       | OpenSSF Scorecard: six checks open on main                                               | roadmap CQ-13 |

## Database and upgrades

| Issue                                                     | Severity | Title                                                                   | Moved to      |
| --------------------------------------------------------- | -------- | ----------------------------------------------------------------------- | ------------- |
| [#52](https://github.com/LaunchAstro/ops-astro/issues/52) | P2       | Upgrade guard: the runner cannot tell a stopped app from an idle one    | roadmap S0-1  |
| [#53](https://github.com/LaunchAstro/ops-astro/issues/53) | P3       | Make the upgrade drill repeatable from the repository                   | roadmap S0-3  |
| [#54](https://github.com/LaunchAstro/ops-astro/issues/54) | P3       | No test names the two owning_operation constraints on field definitions | roadmap CQ-14 |

## Runtime and code quality

| Issue                                                     | Severity | Title                                                                                                         | Moved to                                 |
| --------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| [#76](https://github.com/LaunchAstro/ops-astro/issues/76) | P2       | Upgrade hono: 35 open Dependabot alerts on the version the API runs                                           | roadmap CQ-1                             |
| [#55](https://github.com/LaunchAstro/ops-astro/issues/55) | P3       | Identifier resolution has no production caller, and capability-map discovery has no successor                 | roadmap CQ-13                            |
| [#59](https://github.com/LaunchAstro/ops-astro/issues/59) | P3       | Code-quality clean-ups left for later by the code-quality review                                              | roadmap CQ-4, CQ-6, CQ-7, CQ-8 and CQ-11 |
| [#60](https://github.com/LaunchAstro/ops-astro/issues/60) | P3       | Architecture candidates not yet run: agent envelope, one operation client, lease ownership, package interface | roadmap CQ-4, CQ-6, CQ-7, CQ-8 and CQ-11 |
| [#61](https://github.com/LaunchAstro/ops-astro/issues/61) | P3       | Slice one acceptance: open maintainer questions from the freeze review                                        | roadmap S0-6                             |

## Tests

| Issue                                                     | Severity | Title                                                                                           | Moved to      |
| --------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- | ------------- |
| [#47](https://github.com/LaunchAstro/ops-astro/issues/47) | P3       | CLI test: spawn the shell script from a fixed interpreter path                                  | roadmap CQ-14 |
| [#56](https://github.com/LaunchAstro/ops-astro/issues/56) | P3       | Some suites time out under concurrent load, and one leaks a late audit write into the next test | roadmap CQ-14 |
| [#57](https://github.com/LaunchAstro/ops-astro/issues/57) | P3       | Browser rows I10, R4 and N6 do not record which build served the page                           | roadmap S0-1  |
| [#58](https://github.com/LaunchAstro/ops-astro/issues/58) | P3       | Restart proof does not compare replayed bodies with the pre-restart receipts                    | roadmap CQ-14 |

## Web and mockup parity

| Issue                                                     | Severity | Title                                                                    | Moved to                                  |
| --------------------------------------------------------- | -------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| [#62](https://github.com/LaunchAstro/ops-astro/issues/62) | P2       | Web: no dark theme                                                       | roadmap MP-1-1                            |
| [#63](https://github.com/LaunchAstro/ops-astro/issues/63) | P2       | Web: at 390 wide there is no navigation apart from the breadcrumb        | roadmap MP-2-8                            |
| [#64](https://github.com/LaunchAstro/ops-astro/issues/64) | P3       | Web: at 390 the assignee section shows a block of loading text           | roadmap MP-1-3                            |
| [#65](https://github.com/LaunchAstro/ops-astro/issues/65) | P3       | Board: rank, client, stage, estimate and actual columns show a dash      | roadmap MP-5-8 and MP-4-9                 |
| [#66](https://github.com/LaunchAstro/ops-astro/issues/66) | P3       | Board: facet menu, presets, undo and redo, typeahead and column resize   | roadmap MP-5-3 to MP-5-7                  |
| [#67](https://github.com/LaunchAstro/ops-astro/issues/67) | P3       | Web: no agent panel, gate or run surfaces, and no dock tab for them      | roadmap MP-6-1, MP-3-1, MP-4-8 and MP-6-2 |
| [#68](https://github.com/LaunchAstro/ops-astro/issues/68) | P3       | Task page: subtasks are not built                                        | roadmap MP-4-4                            |
| [#69](https://github.com/LaunchAstro/ops-astro/issues/69) | P3       | Task page: activity as Internal, Client and All tabs                     | roadmap MP-4-5                            |
| [#70](https://github.com/LaunchAstro/ops-astro/issues/70) | P3       | Settings: conversation and retention windows have no place on screen     | roadmap MP-2-11                           |
| [#71](https://github.com/LaunchAstro/ops-astro/issues/71) | P3       | Propose form: take the currency from the cap instead of fixing it to AUD | roadmap CQ-7                              |
| [#72](https://github.com/LaunchAstro/ops-astro/issues/72) | P3       | Web: the mockup's fonts and icons are not used (redistribution question) | roadmap MP-1-2                            |
| [#73](https://github.com/LaunchAstro/ops-astro/issues/73) | P3       | Web: an unsaved edit is lost when the session ends                       | roadmap C58                               |
| [#74](https://github.com/LaunchAstro/ops-astro/issues/74) | P3       | Web: signing in to another business does not offer the held address      | roadmap MP-2-1                            |
