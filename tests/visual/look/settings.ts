// SPDX-License-Identifier: AGPL-3.0-only
//
// B5, settings (PAGE-MAP AGENCY, Settings).
//
// Keys (C31) and Workflow triggers (C33, C52-A). The mockup leaves both
// addresses undesigned (PAGE-MAP FA-AGENCY-88 and FA-AGENCY-91: the one empty
// state until designed), so each panel is held to the design system's list
// card as the mockup draws it: the Portfolio page's "Needs attention" card, a
// DS-COMP-7 list card of DS-COMP-13 page rows with a DS-PRIM-11 soft chip, and
// its DS-PRIM-1 small secondary button.

import type { LookProbe, LookScreen } from './probe.ts';

const PORTFOLIO = { path: '/agency/portfolio/' } as const;
const CARD = '.card.card--flush:has(#alerts)';
const APP = { page: 'agency:settings' } as const;
const WIDTHS = [1480, 900, 390] as const;

const CARD_PROPS = [
  'background-color',
  'border-top-color',
  'border-top-width',
  'box-shadow',
  'padding-top',
];
const TITLE_PROPS = ['font-family', 'font-size', 'font-weight', 'line-height', 'color'];
const SUB_PROPS = ['font-family', 'font-size', 'line-height', 'color'];
const ROW_PROPS = [
  'padding-top',
  'padding-left',
  'column-gap',
  'border-top-width',
  'border-top-color',
];
const ROW_TITLE_PROPS = ['font-family', 'font-size', 'font-weight', 'color'];
const META_PROPS = ['font-family', 'font-size', 'color'];
const CHIP_PROPS = [
  'font-family',
  'font-size',
  'padding-left',
  'border-top-left-radius',
  'background-color',
  'color',
  'box.height',
];
const BUTTON_PROPS = [
  'font-family',
  'font-size',
  'padding-left',
  'background-color',
  'color',
  'border-top-color',
  'box.height',
];

// DS-COMP-13's canonical page row title is Sans 14 at 400; the mockup's
// `.trow__t` is one of the nineteen dialects the list row folds, at 500.
const ROW_TITLE_RULED = [
  { at: 'font-weight@light', want: '400', why: 'DS-COMP-13' },
  { at: 'font-weight@dark', want: '400', why: 'DS-COMP-13' },
];

function panel(name: 'keys' | 'triggers'): LookProbe[] {
  const at = `[data-settings="${name}"]`;
  const probe = (
    element: string,
    mockup: string,
    app: string,
    props: readonly string[],
    ruled?: LookProbe['ruled'],
  ): LookProbe => ({
    id: `settings.${name}-${element}`,
    mockup: { ...PORTFOLIO, selector: mockup },
    app: { ...APP, selector: `${at}${app}` },
    props,
    widths: WIDTHS,
    ...(ruled === undefined ? {} : { ruled }),
  });
  return [
    probe('card', CARD, '', CARD_PROPS),
    probe('title', `${CARD} .card__title`, ' .card__title', TITLE_PROPS),
    probe('sub', `${CARD} .card__sub`, ' .card__sub', SUB_PROPS),
    probe('row', '#alerts a.trow', ' .lrow', ROW_PROPS),
    probe('row-title', '#alerts .trow__t', ' .lrow__title', ROW_TITLE_PROPS, ROW_TITLE_RULED),
    probe('row-meta', '#alerts .trow .muted.t-sm', ' .lrow__meta', META_PROPS),
    probe('chip', '#alertCount', ' .lrow .chip', CHIP_PROPS),
    probe('button', '#portfolioPeriod', ' .lrow .btn', BUTTON_PROPS),
  ];
}

export const SETTINGS: LookScreen = {
  id: 'settings',
  probes: [...panel('keys'), ...panel('triggers')],
};
