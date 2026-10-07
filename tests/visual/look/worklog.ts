// SPDX-License-Identifier: AGPL-3.0-only
//
// SL10, the Work log (MP-8-4; BOARDS "the agency activity ledger"): the
// ledger on Projects, reached by `#worklog` as the mockup's own page is. The
// app opens it by its tab. Day heads, rows and their type are compared; the
// rows' text is made up, so their heights are not.

import type { LookScreen } from './probe.ts';

const PAGE = { path: '/agency/projects/#worklog' } as const;
const APP = { page: 'agency:projects-board', open: 'role=tab[name="Work log"]' } as const;
const TYPE = ['font-family', 'font-size', 'font-weight', 'line-height', 'color'] as const;
const WIDTHS = [1480, 900, 390] as const;

export const WORKLOG: LookScreen = {
  id: 'worklog',
  probes: [
    {
      id: 'worklog.day',
      mockup: { ...PAGE, selector: '.act__day' },
      app: { ...APP, selector: '.act__day' },
      props: [...TYPE, 'letter-spacing', 'text-transform', 'margin-top'],
      widths: WIDTHS,
    },
    {
      id: 'worklog.row',
      mockup: { ...PAGE, selector: '.act__row' },
      app: { ...APP, selector: '.act__row' },
      props: ['padding-top', 'padding-left', 'column-gap', 'border-bottom-color'],
      widths: WIDTHS,
    },
    {
      id: 'worklog.time',
      mockup: { ...PAGE, selector: '.act__t' },
      app: { ...APP, selector: '.act__t' },
      props: [...TYPE],
      widths: WIDTHS,
      // A time is a date: --type-data, Mono 12/1.55 400 (DS-TOK-124, "dates").
      // The mockup's light 12/1.4 has no row in the TOKENS.md census; the one
      // scale holds, and the gap is raised in the handback.
      ruled: (['light', 'dark'] as const).flatMap((theme) => [
        { at: `font-weight@${theme}`, want: '400', why: 'DS-TOK-124' },
        { at: `line-height@${theme}`, want: '18.6px', why: 'DS-TOK-124' },
      ]),
    },
    {
      id: 'worklog.text',
      mockup: { ...PAGE, selector: '.act__text' },
      app: { ...APP, selector: '.act__text' },
      props: [...TYPE],
      widths: WIDTHS,
    },
    {
      // The search row keeps its Clear button at the kit button's height; the
      // mockup stretches it to the search box, which the app's row does not.
      id: 'worklog.clear',
      mockup: { ...PAGE, selector: '[data-act-clear]' },
      app: { ...APP, selector: '.act__find > .btn' },
      props: ['box.height'],
      widths: WIDTHS,
      ruled: (['light', 'dark'] as const).map((theme) => ({
        at: `box.height@${theme}`,
        want: '27',
        why: 'the ledger search row centres its button at the kit height',
      })),
    },
    {
      id: 'worklog.who',
      mockup: { ...PAGE, selector: '.act__who' },
      app: { ...APP, selector: '.act__who' },
      props: [...TYPE],
      widths: WIDTHS,
    },
  ],
};
