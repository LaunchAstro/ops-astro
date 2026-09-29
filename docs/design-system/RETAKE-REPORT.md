<!-- Public edition, generated from the private design-system source by ticket C82's build and checked by the real-names check before it crossed. Do not edit it here; the source changes and the copy is run again. Screenshots and review records stay private, so they are not linked. -->

# Retake report: the design system's screenshots on synthetic data

Ticket C82, under the ruling of 29 September 2026: the design system's screenshots stay in the private repository, and only text crosses. This is the report of the retake, as text: every screenshot group the scrub named, the synthetic data it was retaken on, and every retaken folder with the widths and themes its screenshots hold. The synthetic data was put in place before any capture, in a copy of the frozen mockup served on its own port, and each folder was captured again with its original capture specification and tools, at the widths that specification draws, in light and dark. No image crosses, so none is linked.

## Groups and their synthetic data source

| Group | What the originals showed | Folders | Synthetic data source |
|---|---|---|---|
| SG-1 | staff headshots with first names | 23 | a synthetic roster of four invented people with `@agency.example` addresses, their headshot files replaced under the same names by drawn flat-colour avatars (no original headshot's hash remains) |
| SG-2 | staff names without a photo | 4 | the same synthetic roster |
| SG-3 | a client's advertising figures under the fictional name | 3 | synthetic figures: the real-data seam retired (it reads an empty object) and invented mock figures |
| SG-4 | realistic client domains that may be real sites | 3 | reserved `.example` domains, with fictitious telephone numbers from the regulator's reserved ranges |
| Found by the check | a staff or client name outside the scrub's groups | 22 | the same synthetic roster and invented values |

## Check after the retake

- Headshots: no retaken file has the digest of an original headshot (0 matches).
- Real names: every screenshot was read by OCR, as drawn and inverted, and matched against the private real-names list: 0 real hits after the retake.

## Every retaken folder

| Group | Folder | Screenshots | Widths | Themes |
|---|---|---|---|---|
| SG-1 | `comp/DS-COMP-1` | 16 | 1480, 900, 390 | light, dark |
| SG-1 | `comp/DS-COMP-13` | 24 | 1480 | light, dark |
| SG-1 | `comp/DS-COMP-15` | 12 | 1480 | light, dark |
| SG-1 | `comp/DS-COMP-17` | 22 | 1480, 390 | light, dark |
| SG-1 | `comp/DS-COMP-18` | 8 | 1480, 390 | light, dark |
| SG-1 | `comp/DS-COMP-36` | 4 | 1480, 390 | light, dark |
| SG-1 | `prim/prim16-msg-av` | 2 | 1480 | light, dark |
| SG-1 | `prim/prim16-tmc-av` | 2 | 1480 | light, dark |
| SG-1 | `prim/prim16-viewers` | 2 | 1480 | light, dark |
| SG-1 | `sidebar/DS-SIDE-1` | 6 | 1700, 1480 | light, dark |
| SG-1 | `sidebar/DS-SIDE-7` | 16 | 2240, 1700, 1480, 1100, 390 | light, dark |
| SG-1 | `sidebar/DS-SIDE-7/motion` | 61 | 2240, 1700, 1480, 1100, 390 | light, dark |
| SG-1 | `sidebar/DS-SIDE-11/motion` | 30 | 900, 390 | light, dark |
| SG-1 | `task/ANN-S1-panel-head` | 2 | 1480 | light, dark |
| SG-1 | `task/ANN-S2-team-pane` | 2 | 1480 | light, dark |
| SG-1 | `task/ANN-S4-draft` | 2 | 1480 | light, dark |
| SG-1 | `task/ANN-S5-b-desc-subtasks-time` | 2 | 1480 | light, dark |
| SG-1 | `task/ANN-S5-c-conversation-history` | 2 | 1480 | light, dark |
| SG-1 | `task/ANN-S9-list` | 2 | 1480 | light, dark |
| SG-1 | `task/LAYOUT-390-page-team` | 2 | 390 | light, dark |
| SG-1 | `task/LAYOUT-900-page-team` | 2 | 900 | light, dark |
| SG-1 | `task/LAYOUT-390-page-agent` | 2 | 390 | light, dark |
| SG-1 | `task/LAYOUT-panel` | 4 | 900, 390 | light, dark |
| SG-2 | `comp/DS-COMP-14` | 18 | 1480, 900 | light, dark |
| SG-2 | `comp/DS-COMP-32` | 2 | 1480 | light, dark |
| SG-2 | `task/DS-TASK-11-header` | 4 | 1480, 390 | light, dark |
| SG-2 | `task/ANN-S5-a-header-facts` | 2 | 1480 | light, dark |
| SG-3 | `prim/prim18-term` | 4 | 1480 | light, dark |
| SG-3 | `prim/prim24-stat` | 2 | 1480 | light, dark |
| SG-3 | `prim/prim24-stat-narrow` | 4 | 900, 390 | light, dark |
| SG-4 | `prim/prim20-row` | 4 | 1480 | light, dark |
| SG-4 | `prim/prim20-table` | 2 | 1480 | light, dark |
| SG-4 | `prim/prim20-table-narrow` | 2 | 900 | light, dark |
| Found by the check | `comp/DS-COMP-22` | 14 | 1480 | light, dark |
| Found by the check | `comp/DS-COMP-28` | 4 | 1480 | light, dark |
| Found by the check | `comp/DS-COMP-30` | 2 | 1480 | light, dark |
| Found by the check | `prim/DS-PRIM-33` | 4 | 1480 | light, dark |
| Found by the check | `task/ANN-S3-a-above-seam` | 2 | 1480 | light, dark |
| Found by the check | `task/ANN-S3-b-run-staged` | 2 | 1480 | light, dark |
| Found by the check | `task/ANN-S3-c-gate-to-rank` | 2 | 1480 | light, dark |
| Found by the check | `task/ANN-S6-a-hero` | 2 | 1480 | light, dark |
| Found by the check | `task/ANN-S6-b-staged-gate` | 2 | 1480 | light, dark |
| Found by the check | `task/ANN-S6-d-ops` | 2 | 1480 | light, dark |
| Found by the check | `task/ANN-S6-f-side-brief-asked` | 2 | 1480 | light, dark |
| Found by the check | `task/ANN-S7-graph` | 2 | 1480 | light, dark |
| Found by the check | `task/DS-TASK-4-tph` | 4 | 1480, 390 | light, dark |
| Found by the check | `task/DS-TASK-4-trs` | 4 | 1480, 390 | light, dark |
| Found by the check | `task/DS-TASK-5-wf` | 2 | 1480 | light, dark |
| Found by the check | `task/DS-TASK-7-gate` | 4 | 1480, 390 | light, dark |
| Found by the check | `task/DS-TASK-7-gate-stale` | 2 | 1480 | light, dark |
| Found by the check | `task/DS-TASK-8-history` | 2 | 1480 | light, dark |
| Found by the check | `task/DS-TASK-11-facts` | 2 | 1480 | light, dark |
| Found by the check | `task/DS-TASK-13-node-gate` | 2 | 1480 | light, dark |
| Found by the check | `task/DS-TASK-14-inspector` | 2 | 1480 | light, dark |
| Found by the check | `task/LAYOUT-900-page-agent` | 2 | 900 | light, dark |
