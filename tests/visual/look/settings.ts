// SPDX-License-Identifier: AGPL-3.0-only
//
// B5, settings (PAGE-MAP AGENCY, Settings). The mockup's `/settings/` and its
// six children are placeholder addresses (FA-AGENCY-87 to 93); its one drawn
// settings page is Account, Settings (AC-ST): DS-COMP-26's settings rows
// (`.set__card > .set > .setrow`, AG-X20 and AG-X21) and the segmented
// control (DS-PRIM-10, AG-X22). The app's two business settings are held to it.
// The read states every data page shares (DS-PRIM-28) are not probed here:
// the made-up set answers both reads, and no mockup page draws `.cbd__empty`
// on load.

import type { LookProbe, LookScreen } from './index.ts';

const MOCKUP = { path: '/clients/meridian-dental/account/settings/' } as const;
const APP = { page: 'agency:settings' } as const;
const WIDTHS = [1480, 900, 390] as const;

const probe = (
  id: string,
  mockup: string,
  app: string,
  props: readonly string[],
  extra: Partial<LookProbe> = {},
): LookProbe => ({
  id: `settings.${id}`,
  mockup: { ...MOCKUP, selector: mockup },
  app: { ...APP, selector: app },
  props,
  widths: WIDTHS,
  ...extra,
});

const TYPE = ['font-family', 'font-size', 'font-weight', 'line-height', 'color'] as const;

export const SETTINGS: LookScreen = {
  id: 'settings',
  probes: [
    probe('card', '.set__card', '.set__card', [
      'background-color',
      'border-top-color',
      'border-top-width',
      'padding-top',
      'padding-left',
    ]),
    // The card is capped at a readable measure (46rem), not run to the grid.
    probe('card-measure', '.set__card', '.set__card', ['box.width'], { widths: [1480] }),
    // The canonical card title (DS-TOK-119) is 15/1.1; the mockup draws 15/1.2.
    {
      ...probe('title', '.set__card > .card__title', '.set__card .card__title', TYPE),
      ruled: [
        { at: 'line-height@light', want: '16.5px', why: 'DS-TOK-119 15/1.1' },
        { at: 'line-height@dark', want: '16.5px', why: 'DS-TOK-119 15/1.1' },
      ],
    },
    probe('intro', '.set__card > .card__sub', '.set__card .card__sub', TYPE),
    probe('row', '.setrow + .setrow', '.setrow + .setrow', [
      'padding-top',
      'padding-bottom',
      'border-top-color',
      'border-top-width',
      'column-gap',
      'row-gap',
    ]),
    probe('row-label', '.setrow__k', '.setrow__k', TYPE),
    probe('row-note', '.setrow__note', '.setrow__note', [...TYPE, 'margin-top']),
    probe('row-state', '[data-set="tips"] .setrow__state', '.setrow__state', [
      'font-family',
      'font-size',
      'letter-spacing',
      'text-transform',
      'color',
      'text-align',
    ]),
    probe('row-controls', '[data-set="tips"] .setrow__ctl', '.setrow__ctl', [
      'align-items',
      'row-gap',
    ]),
    probe(
      'segmented-on',
      '[data-set="theme"] .segmented button[aria-pressed="true"]',
      '.setrow .segmented__opt[aria-pressed="true"]',
      [
        'font-family',
        'font-size',
        'letter-spacing',
        'text-transform',
        'color',
        'background-color',
        'padding-left',
        'box.height',
      ],
    ),
    probe(
      'segmented-off',
      '[data-set="theme"] .segmented button[aria-pressed="false"]',
      '.setrow .segmented__opt[aria-pressed="false"]',
      ['color', 'background-color'],
    ),
    // The row's own button: the mockup's Reset, the app's Save (both `.btn--sm`).
    probe('row-button', '[data-set="tips"] .btn--sm', '.setrow .btn--sm', [
      'font-family',
      'font-size',
      'font-weight',
      'padding-left',
      'box.height',
    ]),
  ],
};
