# Open issues after slice one

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

Everything still open when slice one landed on `main` (#41 and #44, 25 September 2026), so it can be picked up later. Each line is a GitHub issue; the issue holds the detail. Severity: **P2** is a real defect or gap a person would notice, **P3** is minor. "Decision" marks an issue that waits on the maintainer before anyone builds.

30 open: 3 at P2, 27 at P3. Nothing open is rated P1 (security, data loss, or the app not starting). Each issue is the record: when one changes or closes, update its row here.

Where they came from: the independent reviews of the slice and its governance gates, Copilot and CodeQL on #41 and #44, the freeze and evidence review at the landing head, the gate runs (flaky tests), and the known gaps against the mockup in `docs/local/WEB.md`. Closed at landing: #45 and #46 (fixed in 9a8b84d).

The mockup is the full specification. A page-by-page inventory of it is planned and will add parity tickets; the web gaps below are the ones already recorded. Slice two and the agent-work pack are tracked separately, as specs and tickets only (#10 to #40).

## Governance and CI

| Issue                                                     | Severity | Title                                                                                    | Source                                                        | Decision |
| --------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------- |
| [#42](https://github.com/LaunchAstro/ops-astro/issues/42) | P3       | governance: an enforceable signal that each review of the head has completed             | Copilot review of #41                                         | yes      |
| [#43](https://github.com/LaunchAstro/ops-astro/issues/43) | P3       | governance: reconcile which merges stay human (CONTRIBUTING, ADR 0046, AGENTS.md)        | Copilot review of #41                                         | yes      |
| [#48](https://github.com/LaunchAstro/ops-astro/issues/48) | P3       | review-evidence-check: outcome lines inside an indented code block are read as fields    | Copilot review of #41 (a thread that arrived after the merge) |          |
| [#49](https://github.com/LaunchAstro/ops-astro/issues/49) | P3       | Independent recheck of the last two gate fixes in #41 (identity trailers, fence parsing) | Landing notes for #41                                         |          |
| [#50](https://github.com/LaunchAstro/ops-astro/issues/50) | P3       | DCO check cannot evaluate a pull request of more than 250 commits                        | Landing notes for #44                                         | yes      |
| [#51](https://github.com/LaunchAstro/ops-astro/issues/51) | P3       | OpenSSF Scorecard: six checks open on main                                               | Code scanning on main (OpenSSF Scorecard)                     |          |

## Database and upgrades

| Issue                                                     | Severity | Title                                                                   | Source                                                 | Decision |
| --------------------------------------------------------- | -------- | ----------------------------------------------------------------------- | ------------------------------------------------------ | -------- |
| [#52](https://github.com/LaunchAstro/ops-astro/issues/52) | P2       | Upgrade guard: the runner cannot tell a stopped app from an idle one    | Independent final review of the migration runner guard | yes      |
| [#53](https://github.com/LaunchAstro/ops-astro/issues/53) | P3       | Make the upgrade drill repeatable from the repository                   | Landing notes (upgrade drill)                          |          |
| [#54](https://github.com/LaunchAstro/ops-astro/issues/54) | P3       | No test names the two owning_operation constraints on field definitions | Freeze packet at the landing head                      |          |

## Runtime and code quality

| Issue                                                     | Severity | Title                                                                                                         | Source                                                    | Decision |
| --------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------- |
| [#55](https://github.com/LaunchAstro/ops-astro/issues/55) | P3       | Identifier resolution has no production caller, and capability-map discovery has no successor                 | Freeze packet at the landing head                         | yes      |
| [#59](https://github.com/LaunchAstro/ops-astro/issues/59) | P3       | Code-quality clean-ups left for later by the code-quality review                                              | Code-quality review, rows ruled "later" during the build  |          |
| [#60](https://github.com/LaunchAstro/ops-astro/issues/60) | P3       | Architecture candidates not yet run: agent envelope, one operation client, lease ownership, package interface | Architecture review during the build (candidates not run) |          |
| [#61](https://github.com/LaunchAstro/ops-astro/issues/61) | P3       | Slice one acceptance: open maintainer questions from the freeze review                                        | Freeze packet at the landing head                         | yes      |

## Tests

| Issue                                                     | Severity | Title                                                                                           | Source                               | Decision |
| --------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- | ------------------------------------ | -------- |
| [#47](https://github.com/LaunchAstro/ops-astro/issues/47) | P3       | CLI test: spawn the shell script from a fixed interpreter path                                  | CodeQL on #44                        |          |
| [#56](https://github.com/LaunchAstro/ops-astro/issues/56) | P3       | Some suites time out under concurrent load, and one leaks a late audit write into the next test | Gate runs during the slice-one build |          |
| [#57](https://github.com/LaunchAstro/ops-astro/issues/57) | P3       | Browser rows I10, R4 and N6 do not record which build served the page                           | Evidence review at the landing head  |          |
| [#58](https://github.com/LaunchAstro/ops-astro/issues/58) | P3       | Restart proof does not compare replayed bodies with the pre-restart receipts                    | Milestone record at the landing head |          |

## Web and mockup parity

| Issue                                                     | Severity | Title                                                                    | Source                        | Decision |
| --------------------------------------------------------- | -------- | ------------------------------------------------------------------------ | ----------------------------- | -------- |
| [#62](https://github.com/LaunchAstro/ops-astro/issues/62) | P2       | Web: no dark theme                                                       | docs/local/WEB.md, known gaps |          |
| [#63](https://github.com/LaunchAstro/ops-astro/issues/63) | P2       | Web: at 390 wide there is no navigation apart from the breadcrumb        | docs/local/WEB.md, known gaps |          |
| [#64](https://github.com/LaunchAstro/ops-astro/issues/64) | P3       | Web: at 390 the assignee section shows a block of loading text           | docs/local/WEB.md, known gaps |          |
| [#65](https://github.com/LaunchAstro/ops-astro/issues/65) | P3       | Board: rank, client, stage, estimate and actual columns show a dash      | docs/local/WEB.md, known gaps |          |
| [#66](https://github.com/LaunchAstro/ops-astro/issues/66) | P3       | Board: facet menu, presets, undo and redo, typeahead and column resize   | docs/local/WEB.md, known gaps |          |
| [#67](https://github.com/LaunchAstro/ops-astro/issues/67) | P3       | Web: no agent panel, gate or run surfaces, and no dock tab for them      | docs/local/WEB.md, known gaps |          |
| [#68](https://github.com/LaunchAstro/ops-astro/issues/68) | P3       | Task page: subtasks are not built                                        | docs/local/WEB.md, known gaps |          |
| [#69](https://github.com/LaunchAstro/ops-astro/issues/69) | P3       | Task page: activity as Internal, Client and All tabs                     | docs/local/WEB.md, known gaps |          |
| [#70](https://github.com/LaunchAstro/ops-astro/issues/70) | P3       | Settings: conversation and retention windows have no place on screen     | docs/local/WEB.md, settings   |          |
| [#71](https://github.com/LaunchAstro/ops-astro/issues/71) | P3       | Propose form: take the currency from the cap instead of fixing it to AUD | docs/local/WEB.md, proposals  |          |
| [#72](https://github.com/LaunchAstro/ops-astro/issues/72) | P3       | Web: the mockup's fonts and icons are not used (redistribution question) | docs/local/WEB.md, known gaps | yes      |
| [#73](https://github.com/LaunchAstro/ops-astro/issues/73) | P3       | Web: an unsaved edit is lost when the session ends                       | docs/local/WEB.md, known gaps | yes      |
| [#74](https://github.com/LaunchAstro/ops-astro/issues/74) | P3       | Web: signing in to another business does not offer the held address      | docs/local/WEB.md, known gaps |          |
