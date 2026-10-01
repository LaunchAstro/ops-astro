// SPDX-License-Identifier: AGPL-3.0-only
//
// SL10's part of the frame (SHELL SH-*): C4's freshness marker in the
// header's meta slot (DS-PRIM-25), held to the mockup's `#fresh` marker on
// Projects. The harness answers the live stream as down, so the app's marker
// draws a lagging state: its colour is a state's, and only its shape is
// compared. The tab row (SH-18, SH-19) is held to Projects' section tabs.
// The mockup draws no person menu, and its rail glyphs show only on the folded
// rail (SL06's MP-2-3), so neither has a mockup element to measure here.

import type { LookScreen } from './types.ts';

const WIDTHS = [1480, 900, 390] as const;

export const FRAME: LookScreen = {
  id: 'frame',
  probes: [
    {
      id: 'frame.freshness',
      mockup: { path: '/agency/projects/', selector: '#fresh .fresh' },
      app: { page: 'agency:task-detail', selector: '.fresh' },
      props: [
        'font-family',
        'font-size',
        'letter-spacing',
        'text-transform',
        'padding-top',
        'padding-left',
        'border-top-width',
        'column-gap',
      ],
      widths: WIDTHS,
      // The mockup's marker type (Mono 10.88/1.55 300 0.02em, a size between
      // tokens) folds to --type-chip, Mono 11/1 400 0.06em (TOKENS.md row 54);
      // its .35rem gap to --s-1-5 (DS-TOK-59).
      ruled: (['light', 'dark'] as const).flatMap((theme) => [
        { at: `font-size@${theme}`, want: '11px', why: 'DS-TOK-128' },
        { at: `letter-spacing@${theme}`, want: '0.66px', why: 'DS-TOK-128' },
        { at: `column-gap@${theme}`, want: '6px', why: 'DS-TOK-59' },
      ]),
    },
    {
      id: 'frame.tab-row',
      mockup: { path: '/projects/', selector: 'nav.tabbar' },
      app: { page: 'agency:projects-board', selector: 'nav.tabbar' },
      // The app keeps the row's 32px inset on its inner scroller (the arrows and
      // the edge fade need it there), so where a tab starts is compared instead.
      props: ['background-color', 'border-bottom-color', 'box.height'],
      widths: WIDTHS,
    },
    {
      id: 'frame.tab',
      mockup: { path: '/projects/', selector: 'a.tabbar__t:not([aria-current])' },
      app: { page: 'agency:projects-board', selector: 'a.tabbar__t:not([aria-current])' },
      props: [
        'font-family',
        'font-size',
        'font-weight',
        'line-height',
        'color',
        'padding-top',
        'padding-bottom',
        'box.x',
      ],
      widths: WIDTHS,
    },
    {
      id: 'frame.tab-current',
      mockup: { path: '/projects/', selector: 'a.tabbar__t[aria-current]' },
      app: { page: 'agency:projects-board', selector: 'a.tabbar__t[aria-current]' },
      props: ['color', 'font-weight'],
      widths: WIDTHS,
    },
    {
      id: 'frame.tab-mark',
      mockup: { path: '/projects/', selector: '.tabmark' },
      app: { page: 'agency:projects-board', selector: '.tabmark' },
      props: ['background-color', 'box.height'],
      widths: WIDTHS,
    },
  ],
};
