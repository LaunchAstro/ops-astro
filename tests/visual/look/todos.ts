// SPDX-License-Identifier: AGPL-3.0-only
//
// My to-dos (MP-7-1), the dock Projects panel's list (PAGE-MAP DOCK, the
// Projects panel PJ-02 to PJ-11; ASTRA-SIDEBAR-REVIEW `todos`).
//
// The mockup has no page of its own for it: the list is measured in the
// Projects panel, opened from its dock tab on `/agency/projects/`. The app
// draws it at `/todos`, so only the list's own parts are compared, never its
// width or where it sits.
//
// At 1480 only: below it the mockup's dock rail sits under the page, so a
// press cannot open the panel there (the width-and-theme harness covers the
// app's narrower widths).

import type { LookProbe, LookScreen } from './probe.ts';

const MOCKUP = { path: '/agency/projects/', open: '[data-dock-tab="todos"]' } as const;
const PANEL = '[data-dock-panel="todos"]';
const APP = { page: 'agency:todos' } as const;
// DS-TOK-10: the faint rule maps to --border, so in dark it is on-dark 10
// percent; the mockup drew white 14.
const RULE_DARK = {
  at: 'border-bottom-color@dark',
  want: 'rgba(245,245,245,26)',
  why: 'DS-TOK-10',
} as const;
// R53 (TOKENS.md census): each text snaps to its canonical type style, so
// where the mockup drew off the scale the build holds the style's value.
const snapped = (prop: string, want: string) =>
  (['light', 'dark'] as const).map((theme) => ({ at: `${prop}@${theme}`, want, why: 'R53' }));
const TYPE = ['font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-transform'];

/** The first row, in the mockup's panel and on the app's page. */
const ROW = '.tl__row';

const probe = (
  id: string,
  selector: string,
  props: readonly string[],
  extra: Partial<LookProbe> = {},
): LookProbe => ({
  id,
  mockup: { ...MOCKUP, selector: `${PANEL} ${selector}` },
  app: { ...APP, selector: `.todos ${selector}` },
  props,
  ...extra,
});

const TODOS_PROBES: readonly LookProbe[] = [
  // PJ-02: the token search, a ruled box with a borderless field in it.
  probe('todos.search', '.tsearch__tags', [
    'padding-top',
    'padding-left',
    'border-top-color',
    'border-top-width',
    'background-color',
    'box.height',
  ]),
  probe('todos.search-input', '.tsearch__in', [
    'font-family',
    'font-size',
    'color',
    'padding-left',
    'border-top-width',
    'background-color',
  ]),
  // PJ-05: the column heads, mono and muted; the sorted one in the ink.
  probe('todos.head', '.tl__head', [
    'font-family',
    'font-size',
    'color',
    'column-gap',
    'padding-bottom',
    'border-bottom-color',
    'border-bottom-width',
  ]),
  probe('todos.head-sorted', '.tl__head button.is-sort', ['font-family', 'font-size', 'color']),
  // DS-COMP-13: the row, ruled faint; PJ-06 the tick; PJ-07 the face.
  probe(
    'todos.row',
    ROW,
    ['padding-top', 'padding-bottom', 'column-gap', 'border-bottom-color', 'border-bottom-width'],
    { ruled: [RULE_DARK] },
  ),
  probe('todos.tick', `${ROW} .sbbox`, [
    'box.width',
    'box.height',
    'border-top-color',
    'border-top-width',
    'background-color',
  ]),
  probe('todos.avatar', `${ROW} .tl__av`, ['box.width', 'box.height', 'border-top-left-radius']),
  // PJ-08: the task name, a link in the ink.
  probe('todos.name', `${ROW} .tl__t a`, [...TYPE, 'color', 'text-decoration-line']),
  // PJ-10: the due in mono, overdue in danger (the mockup's medium weight is
  // drift: `--type-data`).
  probe(
    'todos.due-overdue',
    '.tl__due.is-bad',
    ['font-family', 'font-size', 'font-weight', 'color'],
    { ruled: snapped('font-weight', '400') },
  ),
  probe(
    'todos.due-today',
    '.tl__due.is-now:not(.is-bad)',
    ['font-family', 'font-size', 'font-weight', 'color'],
    { ruled: snapped('font-weight', '400') },
  ),
  // PJ-11: the priority, mono with its line.
  probe('todos.priority', `${ROW} .tl__pri`, ['font-family', 'font-size', 'column-gap']),
];

/**
 * Probes whose markup is UI-POLISH's to build, not this screen's. The column
 * heads: MP-1-3 folds every table head dialect into the kit's one table head
 * (`.table th`), and a list of rows has no kit head to carry it yet, so the list
 * sorts from its select until the kit has one. Empty this list as each is built.
 */
const AWAITING_POLISH: ReadonlySet<string> = new Set(['todos.head', 'todos.head-sorted']);

export const TODOS: LookScreen = {
  id: 'todos',
  probes: TODOS_PROBES.filter((one) => !AWAITING_POLISH.has(one.id)),
};
