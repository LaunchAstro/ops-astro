// SPDX-License-Identifier: AGPL-3.0-only
//
// B5, settings (PAGE-MAP AGENCY, Settings). The mockup's `/settings/` and its
// six children are placeholder addresses (FA-AGENCY-87 to 93); its one drawn
// settings page is Account, Settings (AC-ST): DS-COMP-26's settings rows
// (`.set__card > .set > .setrow`, AG-X20 and AG-X21) and the segmented
// control (DS-PRIM-10, AG-X22, AG-X23). Settings General (MP-2-11) draws its
// three groups, You, Notifications and This business, each as that card, so
// each group is held to it; General is the page they stand on (the mockup's
// content gap between sections, each card at the capped measure).
// The read states every data page shares (DS-PRIM-28) are not probed here:
// the made-up set answers every read, and no mockup page draws `.cbd__empty`
// on load.

import type { LookProbe, LookScreen } from './probe.ts';

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
const CARD = [
  'background-color',
  'border-top-color',
  'border-top-width',
  'padding-top',
  'padding-left',
] as const;
const ROW = [
  'padding-top',
  'padding-bottom',
  'border-top-color',
  'border-top-width',
  'column-gap',
  'row-gap',
] as const;
const STATE = [
  'font-family',
  'font-size',
  'letter-spacing',
  'text-transform',
  'color',
  'text-align',
] as const;
const SEGMENT = [
  'font-family',
  'font-size',
  'letter-spacing',
  'text-transform',
  'color',
  'background-color',
  'padding-left',
  'box.height',
] as const;
const BUTTON = ['font-family', 'font-size', 'font-weight', 'padding-left', 'box.height'] as const;
// The canonical card title (DS-TOK-119) is 15/1.1; the mockup draws 15/1.2.
const TITLE_RULED = {
  ruled: [
    { at: 'line-height@light', want: '16.5px', why: 'DS-TOK-119 15/1.1' },
    { at: 'line-height@dark', want: '16.5px', why: 'DS-TOK-119 15/1.1' },
  ],
} as const;

/** The card, its title and intro, and its rows: what every group shares. */
const group = (name: string, scope: string): LookProbe[] => [
  probe(`${name}.card`, '.set__card', `${scope} .set__card`, CARD),
  // The card is capped at a readable measure (46rem), not run to the grid.
  probe(`${name}.card-measure`, '.set__card', `${scope} .set__card`, ['box.width'], {
    widths: [1480],
  }),
  probe(
    `${name}.title`,
    '.set__card > .card__title',
    `${scope} .set__card .card__title`,
    TYPE,
    TITLE_RULED,
  ),
  probe(`${name}.intro`, '.set__card > .card__sub', `${scope} .set__card > .card__sub`, TYPE),
  probe(`${name}.row`, '.setrow + .setrow', `${scope} .setrow + .setrow`, ROW),
  probe(`${name}.row-label`, '.setrow__k', `${scope} .setrow__k`, TYPE),
  probe(`${name}.row-note`, '.setrow__note', `${scope} .setrow__note`, [...TYPE, 'margin-top']),
];

const YOU = '[data-pref="you"]';
const NOTIFY = '[data-pref="notifications"]';
const BUSINESS = '[data-pref="business"]';

export const SETTINGS: LookScreen = {
  id: 'settings',
  probes: [
    // General: the page the groups stand on, sections a content gap apart.
    probe('general.page', '.content', '[data-screen="settings-general"]', ['row-gap']),

    // You: Appearance and Guided tips are the mockup's own two rows (AG-X22, AG-X23).
    ...group('you', YOU),
    probe(
      'you.segmented-on',
      '[data-set="theme"] .segmented button[aria-pressed="true"]',
      `${YOU} [data-pref="appearance"] .segmented__opt[aria-pressed="true"]`,
      SEGMENT,
    ),
    probe(
      'you.segmented-off',
      '[data-set="theme"] .segmented button[aria-pressed="false"]',
      `${YOU} [data-pref="appearance"] .segmented__opt[aria-pressed="false"]`,
      ['color', 'background-color'],
    ),
    probe(
      'you.tips-controls',
      '[data-set="tips"] .setrow__ctl',
      `${YOU} [data-pref="tips"] .setrow__ctl`,
      ['align-items', 'row-gap'],
    ),
    probe('you.tips-reset', '[data-set="tips"] .btn--sm', `${YOU} [data-pref="tips"] .btn--sm`, [
      ...BUTTON,
      'color',
      'background-color',
      'border-top-color',
    ]),
    probe(
      'you.tips-state',
      '[data-set="tips"] .setrow__state',
      `${YOU} [data-pref="tips"] .setrow__state`,
      STATE,
    ),

    // Notifications: the same rows; the controls are the kit's switch and its
    // not-connected treatment, which the mockup draws on no settings row.
    ...group('notifications', NOTIFY),
    probe(
      'notifications.row-controls',
      '[data-set="tips"] .setrow__ctl',
      `${NOTIFY} .setrow__ctl`,
      ['align-items', 'row-gap'],
    ),

    // This business: the four operation settings and the two windows.
    ...group('business', BUSINESS),
    probe('business.row-state', '[data-set="tips"] .setrow__state', `${BUSINESS} .setrow__state`, [
      ...STATE,
    ]),
    probe('business.row-controls', '[data-set="tips"] .setrow__ctl', `${BUSINESS} .setrow__ctl`, [
      'align-items',
      'row-gap',
    ]),
    probe(
      'business.segmented-on',
      '[data-set="theme"] .segmented button[aria-pressed="true"]',
      `${BUSINESS} .setrow .segmented__opt[aria-pressed="true"]`,
      SEGMENT,
    ),
    probe(
      'business.segmented-off',
      '[data-set="theme"] .segmented button[aria-pressed="false"]',
      `${BUSINESS} .setrow .segmented__opt[aria-pressed="false"]`,
      ['color', 'background-color'],
    ),
    // The row's own button: the mockup's Reset, the app's Save (both `.btn--sm`).
    probe('business.row-button', '[data-set="tips"] .btn--sm', `${BUSINESS} .setrow .btn--sm`, [
      ...BUTTON,
    ]),
  ],
};
