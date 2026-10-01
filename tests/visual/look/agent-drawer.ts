// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent drawer, the dock's `ai` panel (DOCK §9 Client intelligence panel,
// AI-01 to AI-12; SIDEBAR DS-SIDE-2, the first tab). The panel's place in the
// dock (its track, its width, the sheet below 900) is the shell's; these
// probes hold what the panel draws inside it.

import type { LookProbe, LookScreen } from './index.ts';

// 1480 only: at 900 and below the mockup's dock strip sits under the page
// (DS-SIDE-D9, D20), so its Agent tab cannot be pressed to open the panel.
const WIDTHS = [1480] as const;
const MOCKUP = { path: '/agency/projects/', open: '[data-dock-tab="ai"]' } as const;
const APP = { page: 'agency:projects-board', open: '.dock__tab[aria-label="Open Agent"]' } as const;

/** One element, the same selector on both sides unless the app's is named. */
/** A type size the token scale snapped (TOKENS.md, the type census), in both themes. */
const snapped = (prop: string, want: string, why: string): NonNullable<LookProbe['ruled']> => [
  { at: `${prop}@light`, want, why },
  { at: `${prop}@dark`, want, why },
];

const probe = (
  id: string,
  selector: string,
  props: readonly string[],
  more: { app?: string; mockup?: string; ruled?: LookProbe['ruled'] } = {},
): LookProbe => ({
  id: `agent-drawer.${id}`,
  mockup: { ...MOCKUP, selector: more.mockup ?? selector },
  app: { ...APP, selector: more.app ?? selector },
  props,
  widths: WIDTHS,
  ...(more.ruled === undefined ? {} : { ruled: more.ruled }),
});

export const AGENT_DRAWER: LookScreen = {
  id: 'agent-drawer',
  probes: [
    probe('panel', '.aipanel', ['background-color', 'color']),
    probe('head', '.aip__head', [
      'padding-top',
      'padding-left',
      'border-bottom-color',
      'box.height',
    ]),
    // 16.8px display 500 snaps to --type-subheading, 16px, -0.01em (TOKENS type row 63).
    probe(
      'title',
      '.aip__title',
      ['font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-transform', 'color'],
      {
        ruled: [
          ...snapped('font-size', '16px', 'TOKENS-63'),
          ...snapped('letter-spacing', '-0.16px', 'TOKENS-63'),
        ],
      },
    ),
    // .78rem snaps to --text-label, 12px (DS-TOK-43).
    probe('model', '.aip__hmodel', ['font-size', 'color', 'background-color'], {
      mockup: '.aip__hmodel .sel__btn',
      app: 'select.aip__hmodel',
      ruled: snapped('font-size', '12px', 'DS-TOK-43'),
    }),
    // .85rem snaps to --text-body, 14px. No box: the mockup's glyph font is not
    // in the packet, so its eye draws as an empty 11 by 8 button.
    probe('act', '.aip__acts .aip__act', ['color', 'font-size'], {
      ruled: snapped('font-size', '14px', 'DS-TOK-41'),
    }),
    probe('tabs', '.aip__tabs', ['padding-top', 'padding-left', 'border-bottom-color']),
    probe('tab', '.aip__tabs .cmtab[aria-selected="true"]', [
      'font-family',
      'font-size',
      'color',
      'box.height',
    ]),
    // DR-29: chips are pills everywhere, so the corner is not probed; .78rem
    // snaps to 12px (DS-TOK-43) and the line to 1.55 (DR-14).
    probe(
      'chip',
      '.aip__chip',
      [
        'font-size',
        'color',
        'background-color',
        'border-top-color',
        'padding-top',
        'padding-left',
        'box.height',
      ],
      {
        ruled: [
          ...snapped('font-size', '12px', 'DS-TOK-43'),
          ...snapped('box.height', '30', 'DR-14'),
        ],
      },
    ),
    probe('input-row', '.aip__inputrow', [
      'padding-top',
      'padding-bottom',
      'padding-left',
      'border-top-color',
    ]),
    probe('input', '.aip__input', [
      'background-color',
      'color',
      'font-size',
      'padding-left',
      'border-top-color',
      'box.height',
    ]),
    probe('send', '.aip__inputrow .btn', ['font-size', 'background-color', 'color', 'box.height']),
  ],
};
