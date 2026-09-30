// SPDX-License-Identifier: AGPL-3.0-only
//
// SL09, Settings > Telemetry (FA-AGENCY-92). Like Access, the mockup's
// `/settings/telemetry/` is a reserved route drawn by the placeholder-page
// pattern (PAGE-MAP SH-40 to 44). The service-health section is held to that
// page kit: the section head, content cards with title and sub, and the rhythm
// between them; its rows are the made-up `operations.read`.

import type { LookProbe, LookScreen } from './index.ts';

const MOCKUP = { path: '/settings/telemetry/' } as const;
const APP = { page: 'agency:telemetry' } as const;
const WIDTHS = [1480, 900, 390] as const;
const TYPE = ['font-family', 'font-size', 'font-weight', 'line-height', 'color'] as const;
const CARD = 'section.sec > .card';

const probe = (
  id: string,
  mockup: string,
  app: string,
  props: readonly string[],
  extra: Partial<LookProbe> = {},
): LookProbe => ({
  id: `telemetry.${id}`,
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

export const TELEMETRY: LookScreen = {
  id: 'telemetry',
  probes: [
    probe('page', '.content', '[data-screen="telemetry"]', ['row-gap']),
    probe('sec-head', '#routeHeading', '[data-screen="telemetry"] .sec__head', [
      ...TYPE,
      'letter-spacing',
      'text-transform',
    ]),
    probe('cards', '#routeChildren', '[data-health-cards]', ['row-gap']),
    probe('card', CARD, '[data-health="sources"] .card', [
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
      '[data-health="services"] .card__title',
      TYPE,
      TITLE_LEADING,
    ),
    probe('card-sub', `${CARD} .card__sub`, '[data-health="services"] .card__sub', TYPE),
  ],
};
