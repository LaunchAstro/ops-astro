// SPDX-License-Identifier: AGPL-3.0-only
//
// SL06, the dock's Clients panel (DOCK.md section 2, CL-05 to CL-08; SL06
// p-clients), opened from its tab over the board on both sides. Measured at
// 1480 only: at 900 and under, the mockup draws its tab strip below the
// viewport at rest (D-1), so its panel cannot be opened there to measure.

import type { LookProbe, LookScreen } from './index.ts';

const MOCKUP = { path: '/agency/projects/', open: '[data-dock-tab="clients"]' } as const;
const APP = { page: 'agency:projects-board', open: '.dock__tab[data-panel="clients"]' } as const;

const probe = (id: string, mockup: string, app: string, props: readonly string[]): LookProbe => ({
  id: `clients.${id}`,
  mockup: { ...MOCKUP, selector: mockup },
  app: { ...APP, selector: app },
  props,
});

export const CLIENTS: LookScreen = {
  id: 'clients',
  probes: [
    probe('search', '.cl__find .tf__in', '.clbook__find .tf', [
      'box.height',
      'font-size',
      'border-top-color',
      'background-color',
    ]),
    {
      ...probe('count', '.cl__count', '.clbook__count', [
        'font-family',
        'font-size',
        'text-transform',
        'letter-spacing',
        'color',
      ]),
      // DR-10 folded the dark muted ink to 55 percent; the mockup drew 46.
      ruled: [{ at: 'color@dark', want: 'rgba(248,248,248,140)', why: 'DR-10' }],
    },
    probe('item', '.cl__item', '.clbook__item', ['border-bottom-color', 'box.height']),
    probe('tile', '.cl__av', '.clbook__tile', [
      'box.width',
      'box.height',
      'font-family',
      'font-size',
      'font-weight',
      'color',
      'border-top-color',
    ]),
    probe('name', '.cl__nm', '.clbook__name', ['font-size', 'font-weight', 'color']),
    probe('industry', '.cl__ind', '.clbook__industry', ['font-size', 'color']),
  ],
};
