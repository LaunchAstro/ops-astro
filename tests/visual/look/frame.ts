// SPDX-License-Identifier: AGPL-3.0-only
//
// SL10's part of the frame (SHELL SH-*): C4's freshness marker in the
// header's meta slot (DS-PRIM-25), held to the mockup's `#fresh` marker on
// Projects. The harness answers the live stream as down, so the app's marker
// draws a lagging state: its colour is a state's, and only its shape is
// compared. The person menu and the rail are the shell's (look/shell.ts).

import type { LookScreen } from './index.ts';

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
  ],
};
