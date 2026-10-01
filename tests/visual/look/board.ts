// SPDX-License-Identifier: AGPL-3.0-only
//
// B2 and B3, the Projects board and the inbox minimum above it (PAGE-MAP BOARDS, the Projects board).
//
// The board's own parts are measured on the mockup's `/agency/projects/`. The
// tab row (DS-COMP-2) is measured where the mockup draws one (`/agency/brief/`:
// the Projects page has a single tab there), and the inbox card (DS-COMP-7) on
// a mockup page that draws a flush card with a head (`/agency/executive/`).

import type { LookProbe, LookScreen } from './probe.ts';

const PROJECTS = { path: '/agency/projects/' } as const;
const APP = { page: 'agency:projects-board' } as const;
const WIDTHS = [1480, 900, 390] as const;
const WIDE = [1480, 900] as const;
const TYPE = ['font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-transform'];

/** The first task row: the mockup marks it `data-taskrow`, the board machine `data-row`. */
const ROW = 'tbody tr[data-taskrow]';
const APP_ROW = 'tbody tr[data-row]';

const probe = (
  id: string,
  mockup: { path: string; selector: string },
  app: string,
  props: readonly string[],
  extra: Partial<LookProbe> = {},
): LookProbe => ({ id, mockup, app: { ...APP, selector: app }, props, widths: WIDTHS, ...extra });

// DR-10 folded the dark muted ink to 55 percent; the mockup drew 46.
const MUTED_DARK = { at: 'color@dark', want: 'rgba(248,248,248,140)', why: 'DR-10' } as const;

/** R53: the measured styles snap to the canonical type scale; the value it holds, in both themes. */
const R53 = (prop: string, want: string) =>
  (['light', 'dark'] as const).map((theme) => ({ at: `${prop}@${theme}`, want, why: 'R53' }));

const BOARD_PROBES: readonly LookProbe[] = [
  // DS-COMP-2: the tab row and its tabs.
  probe('board.tabrow', { path: '/agency/brief/', selector: 'nav.tabbar' }, 'nav.routetabs', [
    'box.height',
    'padding-left',
    'column-gap',
    'background-color',
    'border-bottom-color',
    'border-bottom-width',
  ]),
  probe(
    'board.tab',
    { path: '/agency/brief/', selector: '.tabbar__t:not(.is-on)' },
    'nav.routetabs a:not([aria-current])',
    [...TYPE, 'color', 'padding-top', 'padding-bottom', 'box.height'],
  ),
  probe(
    'board.tab-current',
    { path: '/agency/brief/', selector: '.tabbar__t.is-on' },
    'nav.routetabs a[aria-current]',
    [...TYPE, 'color', 'box.height'],
  ),
  // The create field, dressed as the mockup's quick-add field (P-02, B-01).
  probe(
    'board.create-field',
    { ...PROJECTS, selector: '.cbd__barq .cbd__field' },
    '.projects__create .cbd__field',
    [
      'box.height',
      'padding-left',
      'border-top-color',
      'background-color',
      'font-family',
      'font-size',
    ],
  ),
  probe(
    'board.create-button',
    { ...PROJECTS, selector: 'button[data-newtask]' },
    '.projects__create button[type=submit]',
    [...TYPE, 'box.height', 'padding-left', 'border-top-color', 'background-color', 'color'],
  ),
  // DS-COMP-17 and DS-COMP-16: the board frame, the filter row, the head.
  probe('board.frame', { ...PROJECTS, selector: '.cbd' }, '.cbd', [
    'border-top-color',
    'background-color',
  ]),
  probe(
    'board.filters',
    { ...PROJECTS, selector: '.cbd__filters' },
    '.cbd__filters',
    ['padding-left', 'column-gap', 'border-bottom-color'],
    { widths: WIDE },
  ),
  probe(
    'board.head',
    { ...PROJECTS, selector: '.cbd__tbl th:nth-child(2) .cbd__th' },
    '.cbd__tbl th:nth-child(2) .cbd__th',
    [...TYPE, 'color', 'padding-top', 'padding-left', 'box.height'],
    // The head is --type-eyebrow, light (R53); the mockup drew it at 400.
    { widths: WIDE, ruled: [MUTED_DARK, ...R53('font-weight', '300')] },
  ),
  probe(
    'board.head-rule',
    { ...PROJECTS, selector: '.cbd__tbl th:nth-child(2)' },
    '.cbd__tbl th:nth-child(2)',
    ['border-bottom-color', 'border-bottom-width'],
    {
      widths: WIDE,
      // One table head (MP-1-3): the kit's --rule, where the mockup's board drew --border-strong.
      ruled: [
        { at: 'border-bottom-color@light', want: 'rgba(0,0,0,255)', why: 'MP-1-3' },
        { at: 'border-bottom-color@dark', want: 'rgba(255,255,255,61)', why: 'MP-1-3' },
      ],
    },
  ),
  // Group headings: the first sits tight under the head, the rest carry a rule.
  probe(
    'board.group-first',
    { ...PROJECTS, selector: 'tr.cbd__grp[data-grp="Active"] > td' },
    // The mockup's first group is Active; the machine's group rows carry no name.
    'tr.cbd__grp:first-child > td',
    ['box.height', 'padding-top', 'padding-left', 'background-color'],
    { widths: WIDE },
  ),
  probe(
    'board.group',
    { ...PROJECTS, selector: 'tr.cbd__grp[data-grp="On hold"] > td' },
    // A later group, ruled off the one above, as On hold is in the mockup.
    'tr.cbd__grp:not(:first-child) > td',
    ['box.height', 'padding-top', 'padding-bottom', 'border-top-color', 'background-color'],
    { widths: WIDE },
  ),
  probe(
    'board.group-label',
    { ...PROJECTS, selector: '.cbd__grpb' },
    '.cbd__grpb',
    [...TYPE, 'color'],
    // --type-subheading (R53): 16 and tracked tight, where the mockup drew 16.8 untracked.
    { widths: WIDE, ruled: [...R53('font-size', '16px'), ...R53('letter-spacing', '-0.16px')] },
  ),
  probe(
    'board.group-reason',
    { ...PROJECTS, selector: '.cbd__grpr' },
    '.cbd__grpr',
    ['font-size', 'color', 'padding-left', 'border-left-color'],
    // --type-caption (R53): 12, where the mockup drew 12.5.
    { widths: WIDE, ruled: R53('font-size', '12px') },
  ),
  // Rows and cells.
  probe('board.row', { ...PROJECTS, selector: ROW }, APP_ROW, ['box.height', 'background-color'], {
    widths: WIDE,
  }),
  probe(
    'board.cell',
    { ...PROJECTS, selector: `${ROW} td:nth-child(4)` },
    `${APP_ROW} td:nth-child(3)`,
    ['padding-left', 'border-bottom-color', ...TYPE, 'color'],
    { widths: WIDE },
  ),
  probe(
    'board.rank',
    { ...PROJECTS, selector: `${ROW} .cbd__rank` },
    `${APP_ROW} .cbd__rank`,
    ['font-family', 'font-size', 'color'],
    { widths: WIDE, ruled: [MUTED_DARK] },
  ),
  probe(
    'board.name',
    { ...PROJECTS, selector: `${ROW} td:nth-child(2) .cbd__nm` },
    `${APP_ROW} td:nth-child(2) .cbd__nm`,
    [...TYPE, 'color', 'text-decoration-line'],
    { widths: WIDE },
  ),
  probe(
    'board.avatar',
    { ...PROJECTS, selector: `${ROW} .cbd__av--p` },
    `${APP_ROW} .av--person`,
    ['box.width', 'box.height', 'border-top-left-radius'],
    { widths: WIDE },
  ),
  probe(
    'board.assignee',
    { ...PROJECTS, selector: `${ROW} .cbd__cell .cbd__nm` },
    `${APP_ROW} .av--person + .cbd__nm`,
    [...TYPE, 'color'],
    { widths: WIDE },
  ),
  probe(
    'board.due',
    { ...PROJECTS, selector: `${ROW} .tl__due` },
    `${APP_ROW} .tl__due`,
    [...TYPE, 'color'],
    { widths: WIDE },
  ),
  probe(
    'board.due-overdue',
    { ...PROJECTS, selector: '.tl__due.is-bad' },
    '.tl__due.is-bad',
    ['font-family', 'font-weight', 'color'],
    // --type-data (R53): an overdue date keeps the regular weight; the danger ink says it.
    { widths: WIDE, ruled: R53('font-weight', '400') },
  ),
  probe(
    'board.due-today',
    { ...PROJECTS, selector: '.tl__due.is-now:not(.is-bad)' },
    '.tl__due.is-now:not(.is-bad)',
    ['font-family', 'font-weight', 'color'],
    { widths: WIDE },
  ),
  probe(
    'board.chip',
    { ...PROJECTS, selector: `${ROW} .cbd__chip` },
    `${APP_ROW} .cbd__chip`,
    [
      'font-family',
      'font-size',
      'padding-top',
      'padding-left',
      'border-top-color',
      'background-color',
      'color',
      'box.height',
    ],
    // --type-caption (R53): 12, where the mockup drew the chip at 11.
    { widths: WIDE, ruled: R53('font-size', '12px') },
  ),
  probe(
    'board.dash',
    { ...PROJECTS, selector: `${ROW} td:last-child .cbd__dim, tbody .cbd__dim` },
    // The mockup's own fallback: the first row's last cell carries a value here.
    `${APP_ROW} td:last-child .cbd__dim, tbody .cbd__dim`,
    ['font-size', 'color'],
    { widths: WIDE },
  ),
  // INB-1: the inbox minimum, a flush card (DS-COMP-7) with the kit's list rows.
  probe(
    'board.inbox-card',
    { path: '/agency/executive/', selector: '.card--flush' },
    'section.inbox',
    ['padding-top', 'row-gap', 'border-top-color', 'background-color'],
  ),
  probe(
    'board.inbox-head',
    { path: '/agency/executive/', selector: '.card--flush > .card__head' },
    'section.inbox > .card__head',
    ['padding-top', 'padding-left'],
  ),
  probe(
    'board.inbox-title',
    { path: '/agency/executive/', selector: '.card--flush .card__title' },
    'section.inbox .card__title',
    [...TYPE, 'color', 'line-height'],
    // --type-card-title (R53): the title line is 1.1, where the mockup drew 1.2.
    { ruled: R53('line-height', '16.5px') },
  ),
  probe(
    'board.inbox-sub',
    { path: '/agency/executive/', selector: '.card--flush .card__sub' },
    'section.inbox .card__sub',
    [...TYPE, 'color'],
  ),
];

/**
 * Probes held off until UI-POLISH's shared components move. None: the board's
 * own markup is built, and where the build holds a ruled value off the mockup
 * the probe names it (`ruled`).
 */
const AWAITING_POLISH: ReadonlySet<string> = new Set([]);

export const BOARD: LookScreen = {
  id: 'board',
  probes: BOARD_PROBES.filter((one) => !AWAITING_POLISH.has(one.id)),
};
