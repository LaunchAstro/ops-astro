// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's own probes (TASK-PAGE.md S2 to S4; PAGE-MAP TASKS S2 to S8)
// and the kit task.ts shares: the header, the Team side's tabs, section heads
// and steps, the description on the page and in the dock task panel, and the
// conversation's head. task.ts lists them with its own, in one screen.
//
// The mockup's header is the found state (a task resolved, run line drawn);
// its conversation is empty, so the thread's head and tabs are measured and
// no message is.

import type { LookProbe } from './probe.ts';

export const WIDTHS = [1480, 900, 390] as const;
const PATH = '/agency/task/?task=proj-grove-hours-copy';
export const PAGE: { readonly path: string } = { path: PATH };
export const PANEL: { readonly path: string; readonly open: string } = {
  path: PATH,
  open: '[data-tp-panel]',
};
export const APP: { readonly page: string } = { page: 'agency:task-detail' };
export const APP_PANEL: { readonly page: string; readonly open: string } = {
  page: APP.page,
  open: '[data-panel-door="open"]',
};

/** A text style: every one maps to a declared type step (MP-1-4). */
export const TYPE = [
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-transform',
  'color',
] as const;

export type Ruled = NonNullable<LookProbe['ruled']>;
export const bothThemes = (prop: string, want: string, why: string): Ruled =>
  (['light', 'dark'] as const).map((theme) => ({ at: `${prop}@${theme}`, want, why }));

/** DR-10 folded the dark faint ink to 55 percent. */
export const FAINT_DARK: Ruled = [
  { at: 'color@dark', want: 'rgba(248,248,248,140)', why: 'DR-10' },
];

/** The gate step's note: TASK-PAGE DT-04 names DS-TOK-124 `--type-data`, not the drawn eyebrow. */
export const GATE_NOTE_RULED: Ruled = [
  ...bothThemes('font-weight', '400', 'TASK-PAGE DT-04, DS-TOK-124'),
  ...bothThemes('line-height', '18.6px', 'TASK-PAGE DT-04, DS-TOK-124'),
  ...bothThemes('letter-spacing', 'normal', 'TASK-PAGE DT-04, DS-TOK-124'),
  ...bothThemes('text-transform', 'none', 'TASK-PAGE DT-04, DS-TOK-124'),
];

/**
 * The task key prints as stored (MP-4-14; TASKS D-14 lists the mockup's capitals
 * as a defect): it is drawn in DS-TOK-124 `--type-data`, case none, not the eyebrow.
 */
const KEY_RULED: Ruled = [
  ...FAINT_DARK,
  ...bothThemes('font-weight', '400', 'MP-4-14, TASKS D-14'),
  ...bothThemes('line-height', '18.6px', 'MP-4-14, TASKS D-14'),
  ...bothThemes('letter-spacing', 'normal', 'MP-4-14, TASKS D-14'),
  ...bothThemes('text-transform', 'none', 'MP-4-14, TASKS D-14'),
];

/** R60: the description is sans everywhere; the mockup's dock field drew it mono. */
export const DESCRIPTION_SANS: Ruled = [
  ...bothThemes('font-family', 'Funnel Sans', 'R60'),
  ...bothThemes('font-size', '14px', 'R60'),
];

/** TOKENS' type map (TICKET-PLAN R53): the drawn style snaps to the row's canonical one. */
const snapped = (row: string, ...pairs: [string, string][]): Ruled =>
  pairs.flatMap(([prop, want]) => bothThemes(prop, want, `TOKENS type row ${row}`));

export const probe = (one: Omit<LookProbe, 'widths'>): LookProbe => ({ ...one, widths: WIDTHS });

/** One page element in the mockup's Team pane and the app's, as a text style. */
const text = (
  id: string,
  at: { mockup: string; app: string },
  ruled?: Ruled,
  props: readonly string[] = TYPE,
): LookProbe =>
  probe({
    id,
    mockup: { ...PAGE, selector: at.mockup },
    app: { ...APP, selector: at.app },
    props,
    ...(ruled === undefined ? {} : { ruled }),
  });

const TEAM = '[data-tp-pane="human"]';
const STEPS = `${TEAM} .sb__sect:has(.sbtasks)`;

export const PAGE_PROBES: readonly LookProbe[] = [
  // S2, MP-4-1: the crumb's door and key, the title and the run line.
  text(
    'task.page-crumb',
    { mockup: '.tpr__crumb .sb__addr', app: '.tpr__crumb .sb__addr' },
    snapped('46', ['font-size', '12px'], ['line-height', '18.6px']),
  ),
  text(
    'task.page-key',
    { mockup: '.tpr__crumb .sbact__meta', app: '.tpr__crumb [data-crumb="key"]' },
    KEY_RULED,
  ),
  // --type-display's line height and tracking scale with its clamped size, and
  // a ruling holds one value per theme, so the title holds the size it scales from.
  text(
    'task.page-title',
    { mockup: '.tpr__title', app: '.tpr__title' },
    snapped('142', ['font-weight', '500']),
    ['font-family', 'font-size', 'font-weight', 'text-transform', 'color'],
  ),
  text('task.page-run-line', { mockup: '.tpr [data-task-runline]', app: '.tpr [data-run]' }),
  // S3, MP-4-4: the Team tab, a section head, the count, a step and the gate's note.
  probe({
    id: 'task.page-tab',
    mockup: { ...PAGE, selector: '[data-tp-tab="human"]' },
    app: { ...APP, selector: '[data-tabs="perspective"] .cmtab[aria-selected="true"]' },
    props: [...TYPE, 'padding-top', 'padding-bottom'],
  }),
  text(
    'task.page-section-key',
    { mockup: `${STEPS} .sb__k`, app: '[data-steps] .sb__k' },
    FAINT_DARK,
  ),
  text('task.page-step-count', {
    mockup: `${STEPS} .sb__meta`,
    app: '[data-steps] [data-step-count]',
  }),
  text(
    'task.page-step-title',
    {
      mockup: `${STEPS} .sbtask:not(.sbtask--gate) .sbtask__t`,
      app: '[data-steps] .sb__step:not([data-gate]) .sb__step-title',
    },
    snapped('78', ['line-height', '21.7px']),
  ),
  // DT-04, D-17: the note keeps one line beside the step, and wraps under it at 390.
  probe({
    id: 'task.page-step-note',
    mockup: { ...PAGE, selector: `${STEPS} .sbtask--gate .sbtask__gm` },
    app: { ...APP, selector: '[data-steps] .sb__gate-note' },
    props: [...TYPE, 'white-space'],
    ruled: GATE_NOTE_RULED,
  }),
  // S3, MP-4-7: the description, read on the page and written in the panel.
  text(
    'task.page-description',
    { mockup: `${TEAM} .md p`, app: '[data-writing="description"] .tt__prose p' },
    snapped('144', ['line-height', '21.7px']),
  ),
  probe({
    id: 'task.panel-description',
    mockup: { ...PANEL, selector: '.dpanel .tf__ta[data-sb="detail"]' },
    app: { ...APP_PANEL, selector: 'aside.dtp textarea[data-writing="description"]' },
    props: [...TYPE, 'padding-left', 'padding-top', 'border-top-color', 'background-color'],
    ruled: [...DESCRIPTION_SANS, ...bothThemes('line-height', '21.7px', 'R60')],
  }),
  // S4, MP-4-5: the conversation's head and its selected tab.
  text(
    'task.page-thread-key',
    { mockup: '.sb__sect--cmt .sb__k', app: '[data-comments="section"] .sb__k' },
    FAINT_DARK,
  ),
  probe({
    id: 'task.page-thread-tab',
    mockup: { ...PAGE, selector: '.sb__sect--cmt .cmtab[aria-selected="true"]' },
    app: { ...APP, selector: '[data-tabs="conversation"] .cmtab[aria-selected="true"]' },
    props: [...TYPE, 'padding-top', 'padding-bottom'],
  }),
];
