// SPDX-License-Identifier: AGPL-3.0-only
//
// B4, the task page's field band and the dock task panel's fields (TASK-PAGE.md
// S1 and S5; PAGE-MAP TASKS S1 to S8), measured on the mockup's Grove Street
// hours copy, the row with the gate step; the app's is the made-up T-1
// (made-up-api.ts), on a board, at a stage, with an estimate, logged time and
// a gate step. task.ts lists them with its own, in one screen.
//
// The panel opens the way a person opens it from the page: the page's door
// (TT-06) in both. The page's Status select (Stage 1 add) is the panel's
// DS-PRIM-5 field select, so it is held to the panel's.

import type { LookProbe } from './probe.ts';
import {
  APP,
  APP_PANEL,
  bothThemes,
  FAINT_DARK,
  GATE_NOTE_RULED,
  PAGE,
  PANEL,
  probe,
  type Ruled,
  TYPE,
} from './task-page.ts';

/** DS-PRIM-5, the field select. */
const SELECT = [
  'font-family',
  'font-size',
  'color',
  'background-color',
  'border-top-color',
  'border-top-width',
  'border-top-left-radius',
  'padding-left',
  'box.height',
] as const;

// The grids' tracks are left to the frames around them (the page gutter is
// the shell's, the panel's width the dock's); the gaps and the frame are ours.
const GRID = ['display', 'column-gap', 'row-gap'] as const;

/**
 * The field label (`.tf__k`): the mockup draws it Mono 12/1.55 400, which
 * TOKENS' type map drops to DS-TOK-126 `--type-eyebrow` (row 8, drift); its
 * dark ink is the folded faint ink (DR-10).
 */
const LABEL_RULED: Ruled = [
  ...bothThemes('font-weight', '300', 'TOKENS type row 8, DS-TOK-126'),
  ...bothThemes('line-height', '16.8px', 'TOKENS type row 8, DS-TOK-126'),
  { at: 'color@dark', want: 'rgba(248,248,248,140)', why: 'DR-10' },
];

const select = (
  id: string,
  sb: string,
  app: string,
  open: { readonly page: string; readonly open?: string } = APP_PANEL,
): LookProbe =>
  probe({
    id,
    mockup: { ...PANEL, selector: `.dpanel .sb__fields select[data-sb="${sb}"]` },
    app: { ...open, selector: app },
    props: SELECT,
  });

export const FIELD_PROBES: readonly LookProbe[] = [
  // S5, TP-10: the page's read-only field band; its gaps are task.ts's
  // `task.facts-grid`. DS-COMP-26: the read-only form's frame, the mockup's
  // `.taskform`.
  probe({
    id: 'task.facts-frame',
    mockup: { ...PAGE, selector: '.tpr__facts .taskform' },
    app: { ...APP, selector: '.tpr__facts .taskform' },
    props: ['padding-top', 'padding-left', 'padding-bottom', 'background-color'],
  }),
  probe({
    id: 'task.facts-label',
    mockup: { ...PAGE, selector: '.tpr__facts .tf__grid .tf__k' },
    app: { ...APP, selector: '.tpr__facts .tf__grid .tf__k' },
    props: TYPE,
    ruled: LABEL_RULED,
  }),
  probe({
    id: 'task.facts-value',
    mockup: { ...PAGE, selector: '.tpr__facts .tf__grid .sb__state' },
    app: { ...APP, selector: '.tpr__facts .tf__grid .sb__state' },
    props: TYPE,
  }),
  // S5, TT-06: a door to the dock task panel, DS-PRIM-1 `--text` in DS-TOK-124.
  probe({
    id: 'task.panel-door',
    mockup: { ...PAGE, selector: '.tt__more[data-tp-panel]' },
    app: { ...APP, selector: '.tt__more[data-panel-door]' },
    props: [...TYPE, 'text-align'],
  }),
  // S1, DP-18 to DP-25: the panel's two-column field grid and its selects.
  probe({
    id: 'task.panel-grid',
    mockup: { ...PANEL, selector: '.dpanel .sb__fields .tf__grid' },
    app: { ...APP_PANEL, selector: 'aside.dtp .dtp__fields' },
    props: GRID,
  }),
  probe({
    id: 'task.panel-label',
    mockup: { ...PANEL, selector: '.dpanel .sb__fields .tf__k' },
    app: { ...APP_PANEL, selector: 'aside.dtp .dtp__fields .tf__k' },
    props: TYPE,
    ruled: LABEL_RULED,
  }),
  select('task.panel-project', 'board', 'aside.dtp #panel-field-board'),
  select('task.panel-stage', 'stage', 'aside.dtp #panel-field-stage'),
  select('task.panel-status', 'status', 'aside.dtp #panel-field-status'),
  select('task.page-status', 'status', '#task-field-status', APP),
  // S2, DT-09: the burn bar. The mockup's agent row folds its time track,
  // so its drawn height is read from the style, not the box.
  probe({
    id: 'task.panel-burn',
    mockup: { ...PANEL, selector: '.dpanel .sb__sh--tt + div > .tt__bar' },
    app: { ...APP_PANEL, selector: 'aside.dtp .sb__burn' },
    props: ['height', 'background-color', 'border-top-left-radius'],
    // DS-PRIM-23: the time track's track is `--border`; the mockup mixed ink at 12%.
    ruled: [{ at: 'background-color@dark', want: 'rgba(245,245,245,26)', why: 'DS-PRIM-23' }],
  }),
  // S2, DT-04: the gate step, no tick, its note trailing.
  probe({
    id: 'task.panel-gate-note',
    mockup: { ...PANEL, selector: '.dpanel .sbtask--gate .sbtask__gm' },
    app: { ...APP_PANEL, selector: 'aside.dtp .sb__gate-note' },
    props: TYPE,
    ruled: GATE_NOTE_RULED,
  }),
  // S2, DT-22 and DT-23 (MP-4-16): the history section's head, its latest change on
  // the head line, and the fold that shows the trail.
  probe({
    id: 'task.panel-history-key',
    mockup: { ...PANEL, selector: '.dpanel .sb__sect--hist .sb__k' },
    app: { ...APP_PANEL, selector: 'aside.dtp [data-history] .sb__k' },
    props: TYPE,
    ruled: FAINT_DARK,
  }),
  probe({
    id: 'task.panel-history-latest',
    mockup: { ...PANEL, selector: '.dpanel .sb__sect--hist .sb__meta' },
    app: { ...APP_PANEL, selector: 'aside.dtp [data-history="latest"]' },
    props: TYPE,
  }),
  probe({
    id: 'task.panel-history-more',
    mockup: { ...PANEL, selector: '.dpanel .sb__sect--hist .tt__more' },
    app: { ...APP_PANEL, selector: 'aside.dtp [data-history] .tt__more' },
    props: TYPE,
  }),
  // S1, DP-30 (MP-4-12): the page link's label and its value.
  probe({
    id: 'task.panel-link-label',
    mockup: { ...PANEL, selector: '.dpanel .sb__linkrow:has([data-sb-at]) .tf__k' },
    app: { ...APP_PANEL, selector: 'aside.dtp .dtp__link .tf__k' },
    props: TYPE,
    ruled: LABEL_RULED,
  }),
  probe({
    id: 'task.panel-link-value',
    mockup: { ...PANEL, selector: '.dpanel [data-sb-at]' },
    app: { ...APP_PANEL, selector: 'aside.dtp .dtp__link [data-page-link="value"]' },
    props: TYPE,
  }),
];
