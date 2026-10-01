// SPDX-License-Identifier: AGPL-3.0-only
//
// Executive rollup, section 005 only (PAGE-MAP AGENCY "Executive Rollup",
// AG-E29 to AG-E33; MP-14-6): the cost tiles, the cost log and the two roll-up
// cards. Sections 001 to 004 are MP-14-3's stand-ins and the section head is
// the kit's to come, so neither is probed here.

import type { LookProbe, LookScreen } from './probe.ts';

const PAGE = { path: '/agency/executive/' } as const;
const APP = { page: 'agency:executive' } as const;
const WIDTHS = [1480, 900, 390] as const;
const SECTION = '[data-section="005"]';

/** One element, measured at the three widths in both themes. */
const probe = (id: string, mockup: string, app: string, props: readonly string[]): LookProbe => ({
  id: `executive.${id}`,
  mockup: { ...PAGE, selector: mockup },
  app: { ...APP, selector: `${SECTION} ${app}` },
  props,
  widths: WIDTHS,
});

const TYPE = ['font-family', 'font-size', 'font-weight', 'color'] as const;
const LABEL = [...TYPE, 'letter-spacing', 'text-transform'] as const;

export const EXECUTIVE: LookScreen = {
  id: 'executive',
  probes: [
    probe('cost-tiles', '#costKpis', '.statrow', [
      'display',
      'border-bottom-style',
      'border-bottom-color',
    ]),
    probe('cost-tile-label', '#costKpis .stat__label', '.stat__label', LABEL),
    probe('cost-tile-number', '#costKpis .stat__num', '.stat__num', TYPE),
    probe('cost-log-card', '#agentcost .card--flush', '.card--flush', [
      'background-color',
      'border-top-color',
      'border-top-width',
      'padding-top',
    ]),
    probe('cost-log-head', '#costLog th', '.table th', [...LABEL, 'padding-top']),
    probe('cost-log-cell', '#costLog td', '.table td', [
      'font-size',
      'padding-top',
      'padding-left',
      'border-bottom-color',
    ]),
    probe('cost-model-id', '#costLog .skc__model', '.table .skc__model', [
      'font-family',
      'font-size',
      'overflow-wrap',
    ]),
    probe('rollup-title', '#agentcost .stack .card__title', '.stack .card__title', TYPE),
    probe('rollup-sub', '#agentcost .stack .card__sub', '.stack .card__sub', TYPE),
    probe('rollup-meter', '#costWho .meter', '[data-cost-attached] .meter', [
      'height',
      'background-color',
    ]),
  ],
};
