// SPDX-License-Identifier: AGPL-3.0-only
//
// SL09, Settings > Access (FA-AGENCY-89). The mockup's `/settings/access/` is a
// reserved route drawn by the placeholder-page pattern (PAGE-MAP SH-40 to 44):
// section heads (DS-COMP-4), content cards (DS-COMP-7) with their title and
// sub, the outlined chip, and the page's section rhythm. The app's Access page
// is held to that page kit; its rows are the made-up `access.read`.

import type { LookProbe, LookScreen } from './index.ts';

const MOCKUP = { path: '/settings/access/' } as const;
const APP = { page: 'agency:access' } as const;
const WIDTHS = [1480, 900, 390] as const;
const TYPE = ['font-family', 'font-size', 'font-weight', 'line-height', 'color'] as const;
/** The placeholder's one content card (Port handoff), not the door cards in the grid. */
const CARD = 'section.sec > .card';

const probe = (
  id: string,
  mockup: string,
  app: string,
  props: readonly string[],
  extra: Partial<LookProbe> = {},
): LookProbe => ({
  id: `access.${id}`,
  mockup: { ...MOCKUP, selector: mockup },
  app: { ...APP, selector: app },
  props,
  widths: WIDTHS,
  ...extra,
});

// DS-TOK-50 folded the mockup's literal 1.2 card-title leading into --lh-title (1.1).
const TITLE_LEADING = {
  ruled: (['light', 'dark'] as const).map((theme) => ({
    at: `line-height@${theme}`,
    want: '16.5px',
    why: 'DS-TOK-50',
  })),
};

export const ACCESS: LookScreen = {
  id: 'access',
  probes: [
    probe('page', '.content', '[data-screen="access"]', ['row-gap']),
    probe('sec-head', '#routeHeading', '[data-screen="access"] .sec__head', [
      ...TYPE,
      'letter-spacing',
      'text-transform',
    ]),
    probe('sec', 'section.sec:has(#routeHeading)', '[data-screen="access"] .sec', ['row-gap']),
    probe('cards', '#routeChildren', '[data-access-lists]', ['row-gap']),
    probe('card', CARD, '[data-access="give"] .card', [
      'background-color',
      'border-top-color',
      'border-top-width',
      'border-top-left-radius',
      'padding-top',
      'padding-left',
    ]),
    probe(
      'card-title',
      `${CARD} .card__title`,
      '[data-access="agents"] .card__title',
      TYPE,
      TITLE_LEADING,
    ),
    probe('card-sub', `${CARD} .card__sub`, '[data-access="agents"] .card__sub', TYPE),
    probe('chip', '.topbar__meta .chip', '[data-access="team"] .chip', [
      'font-family',
      'font-size',
      'letter-spacing',
      'text-transform',
      'color',
      'border-top-color',
      'padding-left',
    ]),
  ],
};
