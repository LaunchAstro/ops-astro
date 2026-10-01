// SPDX-License-Identifier: AGPL-3.0-only
//
// SL06, the dock: its edge rail, tab, callout, Close all, sheet strip, bottom
// strip, panel, head, head button and width grip (SIDEBAR.md Part 1, DS-SIDE-1
// to 10), at 1480 (floating), 1700 (seated), 1279 (the sheet tier) and 390
// (the bottom strip), both themes. A probe that needs a panel opens Team, a
// panel both sides register, the way a person would.
//
// The build registers fewer panels than the mockup's eight (R34: only a panel
// with a body gets a door), so the rail's and the sheet strip's length, and
// with it the rail's top, are ruled; that the rail stays centred on the right
// edge is held against the pinned mockup box in tests/web/dock-visual.test.ts.

import type { LookProbe, LookScreen } from './types.ts';

const HOME = { path: '/dashboard/' } as const;
const APP = { page: 'agency:projects-board' } as const;
/** Team, opened the way a person would: the visible door (the rail, or the sheet strip). */
const TEAM = {
  mockup: '[data-dock-tab="team"]:visible',
  app: '.dock__tab[data-panel="team"]',
} as const;
const SIDE = [1480, 1700] as const;

const probe = (
  id: string,
  selectors: { mockup: string; app: string },
  props: readonly string[],
  more: { widths?: readonly number[]; open?: boolean; ruled?: Ruled } = {},
): LookProbe => ({
  id: `dock.${id}`,
  mockup: {
    ...HOME,
    selector: selectors.mockup,
    ...(more.open === true ? { open: TEAM.mockup } : {}),
  },
  app: { ...APP, selector: selectors.app, ...(more.open === true ? { open: TEAM.app } : {}) },
  props,
  widths: more.widths ?? [1480],
  ...(more.ruled === undefined ? {} : { ruled: more.ruled }),
});

type Ruled = NonNullable<LookProbe['ruled']>;

/** DR-10 folded the dark muted ink to 55 percent; the mockup drew 46. */
const MUTED_DARK: Ruled = [{ at: 'color@dark', want: 'rgba(248,248,248,140)', why: 'DR-10' }];

/** Both themes hold one ruled value. */
const both = (prop: string, want: string, why: string): Ruled => [
  { at: `${prop}@light`, want, why },
  { at: `${prop}@dark`, want, why },
];

const RAIL = { mockup: 'nav.dock__rail', app: '.dock__rail' };
const PANEL = { mockup: 'section.dpanel[data-dock-panel="team"]', app: '.dpanel' };
const HEAD = { mockup: `${PANEL.mockup} .dpanel__head`, app: '.dpanel__head' };

export const DOCK: LookScreen = {
  id: 'dock',
  probes: [
    // DS-SIDE-1 at rest: 40 wide, flush on the right edge, its ground, its
    // three-sided border and its small shadow.
    probe(
      'rail-rest',
      RAIL,
      [
        'box.width',
        'box.x',
        'box.height',
        'box.y',
        'padding-top',
        'row-gap',
        'background-color',
        'border-top-color',
        'border-left-width',
        'border-right-width',
        'box-shadow',
      ],
      {
        widths: SIDE,
        // Three doors, not eight: 113 tall, centred on the edge below the app strip.
        ruled: [...both('box.height', '113', 'R34'), ...both('box.y', '416', 'R34')],
      },
    ),
    // A panel open: the shadow goes, Close all is added, the rail rides the panel.
    probe('rail-open', RAIL, ['box.width', 'box.x', 'box-shadow'], { widths: SIDE, open: true }),
    // DS-SIDE-1 at 390: the strip on the bottom edge, on screen at rest (R33, not D9).
    probe(
      'strip-rest',
      RAIL,
      ['box.width', 'box.height', 'box.y', 'background-color', 'border-top-color'],
      { widths: [390], ruled: both('box.y', '860', 'R33') },
    ),
    // DS-SIDE-2: an idle tab and an open one.
    probe(
      'tab',
      {
        mockup: 'nav.dock__rail .dock__tab[data-dock-tab="team"]',
        app: '.dock__tab[data-panel="team"]',
      },
      ['box.width', 'box.height', 'color', 'background-color', 'cursor'],
      { widths: [1480, 390], ruled: MUTED_DARK },
    ),
    probe(
      'tab-on',
      {
        mockup: 'nav.dock__rail .dock__tab[data-dock-tab="team"]',
        app: '.dock__rail .dock__tab[data-panel="team"]',
      },
      ['color', 'background-color'],
      { widths: SIDE, open: true },
    ),
    // DS-SIDE-3: the callout's dialect (display-gated, so its box is measured by hover elsewhere).
    probe(
      'callout',
      {
        mockup: 'nav.dock__rail .dock__tab[data-dock-tab="team"] .dock__tablabel',
        app: '.dock__tab[data-panel="team"] .dock__tablabel',
      },
      [
        'background-color',
        'color',
        'font-family',
        'font-size',
        'padding-top',
        'padding-left',
        'max-width',
      ],
      // .78rem snaps to the label step (TOKENS DS-TOK-43: text sizes are tokens);
      // the 1px edge MP-1-1 holds in dark takes its pixel from the padding, so
      // the chip's outer size is the mockup's.
      {
        ruled: [
          ...both('font-size', '12px', 'DS-TOK-43'),
          ...both('padding-top', '4.6px', 'MP-1-1 dock callout edge'),
          ...both('padding-left', '8.6px', 'MP-1-1 dock callout edge'),
        ],
      },
    ),
    // DS-SIDE-5: Close all, with a panel open.
    probe(
      'closeall',
      { mockup: 'nav.dock__rail .dock__closeall', app: '.dock__rail .dock__closeall' },
      ['box.width', 'box.height', 'color'],
      { open: true, ruled: MUTED_DARK },
    ),
    // DS-SIDE-6: the sheet strip on the sheet's top edge, 901 to 1279.
    probe(
      'sheet-strip',
      { mockup: '.dock__sheettabs', app: '.dock[data-mode="sheet"] .dock__rail' },
      [
        'box.height',
        'padding-top',
        'padding-left',
        'background-color',
        'border-top-color',
        'border-bottom-width',
      ],
      { widths: [1279], open: true },
    ),
    // DS-SIDE-7: the panel floating (1480), seated (1700) and as the sheet (1279).
    // At 390 the mockup's strip is off screen at rest (D9), so no person can
    // open a panel there: the phone panel is held against the inventory's
    // capture in tests/web/dock-visual.test.ts.
    probe(
      'panel',
      PANEL,
      ['box.x', 'box.y', 'box.width', 'box.height', 'background-color', 'border-left-color'],
      { widths: [1480, 1700], open: true },
    ),
    // The sheet's height is the layout's default (apps/web/src/dock/use-layout.ts,
    // outside this piece): its top and height are a todo in dock-visual.test.ts.
    probe('panel-sheet', PANEL, ['box.x', 'box.width', 'background-color'], {
      widths: [1279],
      open: true,
    }),
    // DS-SIDE-8: the head, and its label.
    probe(
      'head',
      HEAD,
      [
        'box.height',
        'padding-top',
        'padding-right',
        'padding-left',
        'border-bottom-color',
        'border-bottom-width',
      ],
      { widths: [1480, 1279], open: true },
    ),
    probe(
      'head-label',
      { mockup: `${HEAD.mockup} .dpanel__id span`, app: '.dpanel__name' },
      ['font-family', 'font-size', 'font-weight', 'color'],
      // 16.8 snaps to the subheading step (TOKENS row 63, DS-TOK-111).
      { open: true, ruled: both('font-size', '16px', 'DS-TOK-111') },
    ),
    // DS-SIDE-9: the head's X.
    probe(
      'head-x',
      { mockup: `${HEAD.mockup} [data-dock-close]`, app: '.dpanel__head .dpanel__x' },
      ['box.width', 'box.height', 'color', 'padding-left'],
      { open: true, ruled: MUTED_DARK },
    ),
    // DS-SIDE-10: the width grip on the panel's inner edge, idle.
    probe(
      'grip',
      { mockup: `${PANEL.mockup} .dpanel__grip`, app: '.dpanel__grip' },
      ['box.width', 'box.x', 'cursor', 'background-color'],
      { open: true },
    ),
  ],
};
