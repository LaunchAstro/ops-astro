// SPDX-License-Identifier: AGPL-3.0-only
//
// The read states and the held addresses (UI-STATES): the screens a person
// meets when a page has no rows, cannot be read, or is not built yet. Each is
// held to the one empty state (DS-PRIM-28 `--block`), measured where the
// pinned mockup draws it on load: `.cbd__empty`, the house empty state
// (`assets/taskpage.js:49`), on a task address that names no task. The held
// address's page head is held to the mockup's reserved-route placeholder
// (`/route-home/`, served at `/dashboard/`): its title and placeholder chip
// (PAGE-MAP SHELL SH-40). Its body is the one empty state, not the mockup's
// banner, door cards and port handoff: DS-COMP-36 was retired (R2 (a)).
// The loading line is DS-PRIM-29's panel line, which no mockup page draws, so
// it is held by the surface tests instead.

import type { LookProbe, LookScreen } from './probe.ts';

const WIDTHS = [1480, 900, 390] as const;
const EMPTY = { path: '/agency/task/?task=NOPE', selector: '.cbd__empty' } as const;
const SAY = { ...EMPTY, selector: '.cbd__empty > p:first-child' } as const;
const PLACEHOLDER = { path: '/dashboard/' } as const;

/** Every app state drawn as the one empty state, and where to find it. */
const STATES: readonly { readonly id: string; readonly app: LookProbe['app'] }[] = [
  {
    id: 'held',
    app: {
      page: 'agency:projects-board',
      path: '/dashboard/',
      selector: '[data-outcome="placeholder"] > .empty',
    },
  },
  {
    id: 'board-empty',
    app: {
      page: 'agency:projects-board',
      selector: '[data-outcome="empty"] > .empty',
      reads: { empty: ['task.board'] },
    },
  },
  {
    id: 'board-unavailable',
    app: {
      page: 'agency:projects-board',
      selector: '[data-outcome="unavailable"] > .empty',
      reads: { unavailable: ['task.board'] },
    },
  },
  {
    id: 'board-refused',
    app: {
      page: 'agency:projects-board',
      selector: '[data-outcome="denied"] > .empty',
      reads: { refused: ['task.board'] },
    },
  },
  {
    id: 'task-unavailable',
    app: {
      page: 'agency:task-detail',
      selector: '[data-outcome="unavailable"] > .empty',
      reads: { unavailable: ['task.read'] },
    },
  },
  {
    id: 'not-found',
    app: {
      page: 'agency:projects-board',
      path: '/nowhere/',
      selector: '[data-outcome="not-found"] > .empty',
    },
  },
  {
    id: 'signed-in',
    app: { page: 'agency:sign-in', path: '/sign-in', selector: '.readstate > .empty' },
  },
];

const BLOCK = [
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'text-align',
  'color',
  'font-family',
  'font-size',
  'line-height',
] as const;
// Each line of the block: the mockup's lines are paragraphs 1em apart.
const LINE = [
  'font-family',
  'font-size',
  'line-height',
  'font-weight',
  'color',
  'text-align',
  'margin-top',
  'margin-bottom',
];

/** The block's line in the app: its title, or the line under it. */
const line = (app: LookProbe['app'], part: 'title' | 'desc'): LookProbe['app'] => ({
  ...app,
  selector: `${app.selector} > .empty__${part}`,
});
/** The states whose block says why under its title (the signed-in gate has no reason). */
const WHY = new Set([
  'held',
  'board-empty',
  'board-unavailable',
  'board-refused',
  'task-unavailable',
  'not-found',
]);

export const STATES_SCREEN: LookScreen = {
  id: 'states',
  probes: [
    ...STATES.flatMap(({ id, app }): LookProbe[] => {
      const block: LookProbe = {
        id: `states.${id}`,
        mockup: EMPTY,
        app,
        props: BLOCK,
        widths: WIDTHS,
      };
      const parts = WHY.has(id) ? (['title', 'desc'] as const) : (['title'] as const);
      return [block].concat(
        parts.map((part) => ({
          id: `states.${id}-${part}`,
          mockup: SAY,
          app: line(app, part),
          props: LINE,
          widths: WIDTHS,
        })),
      );
    }),
    // The way on from the not-found gate: the mockup's door link under the line.
    {
      id: 'states.not-found-way',
      mockup: { ...EMPTY, selector: '.cbd__empty .sb__addr' },
      app: {
        page: 'agency:projects-board',
        path: '/nowhere/',
        selector: '[data-outcome="not-found"] .empty__action .sb__addr',
      },
      props: ['font-family', 'font-size', 'color', 'text-decoration-line'],
      ruled: (['light', 'dark'] as const).map((theme) => ({
        at: `font-size@${theme}`,
        want: '12px',
        why: 'DS-TOK-124 (the 13 snaps to the data style)',
      })),
      widths: WIDTHS,
    },
    // The held address's page head: the route's label, and the outline chip
    // that says the page is not built (the mockup's "Placeholder page").
    {
      id: 'states.held-chip',
      mockup: { ...PLACEHOLDER, selector: '.topbar__meta .chip--outline' },
      app: {
        page: 'agency:projects-board',
        path: '/dashboard/',
        selector: '.topbar__meta .chip--outline',
      },
      props: [
        'font-family',
        'font-size',
        'font-weight',
        'letter-spacing',
        'text-transform',
        'color',
        'border-top-width',
        'border-top-color',
        'padding-top',
        'padding-left',
        'box.height',
      ],
      widths: WIDTHS,
    },
  ],
};
