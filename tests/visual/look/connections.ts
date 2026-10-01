// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal, sections 001 to 008 (PAGE-MAP AGENCY "Connections &
// Signal"; MP-14-7a, MP-14-8): the fleet, the connectors, the stand-ins for
// 003 to 005, and the signal (grants, tripwires, the night round). Sections
// 009 to 012 are in connections-costing.ts.

import type { LookProbe, LookScreen } from './index.ts';

const PAGE = { path: '/agency/connections-and-signal/' } as const;
const APP = { page: 'agency:connections' } as const;
const WIDTHS = [1480, 900, 390] as const;

/** One element, measured at the three widths in both themes. */
const probe = (
  id: string,
  mockup: string,
  app: string,
  props: readonly string[],
  more: Partial<LookProbe> = {},
): LookProbe => ({
  id: `connections.${id}`,
  mockup: { ...PAGE, selector: mockup },
  app: { ...APP, selector: app },
  props,
  widths: WIDTHS,
  ...more,
});

const TYPE = ['font-family', 'font-size', 'font-weight', 'color'] as const;
const LABEL = [...TYPE, 'letter-spacing', 'text-transform'] as const;

export const CONNECTIONS: LookScreen = {
  id: 'connections',
  probes: [
    probe('section-rule', '#h1 .sec__meta', '[data-section="001"] .sec__meta', [
      'border-top-color',
      'border-top-width',
      'padding-top',
    ]),
    probe(
      'section-number',
      '#h1 .sec__meta .u-tag',
      '[data-section="001"] .sec__meta .u-tag',
      LABEL,
    ),
    probe('section-head', '#h1 .sec__head', '[data-section="001"] .sec__head', [
      ...LABEL,
      'margin-top',
    ]),
    probe('fleet-banner', '#fleetBanner .banner--bad', '[data-fleet-banner]', [
      'background-color',
      'border-top-color',
      'padding-top',
      'padding-left',
    ]),
    probe('fleet-tiles', '#fleet.statrow', '[data-section="001"] .statrow', [
      'display',
      'border-bottom-style',
      'border-bottom-color',
    ]),
    // Padding only: the mockup draws five tiles and the fleet read has three
    // (its two queue counts have no source yet), so a tile's width differs.
    probe('fleet-tile', '#fleet .stat', '[data-section="001"] .statrow > .stat', [
      'padding-top',
      'padding-right',
    ]),
    probe('fleet-tile-label', '#fleet .stat__label', '[data-section="001"] .stat__label', LABEL),
    probe('fleet-tile-number', '#fleet .stat__num', '[data-section="001"] .stat__num', TYPE),
    probe('facet', '#connCtrls .facet', '[data-section="002"] .facet', [
      'font-size',
      'color',
      'background-color',
      'border-top-color',
      'padding-left',
      'box.height',
    ]),
    probe(
      'facet-pressed',
      '#connCtrls .facet[aria-pressed="true"]',
      '[data-section="002"] .facet[aria-pressed="true"]',
      ['border-top-color', 'color'],
    ),
    probe('table-head', 'table.conn thead th', 'table.conn thead th', [
      ...LABEL,
      'padding-left',
      'border-bottom-color',
    ]),
    probe('table-cell', 'table.conn .conn__row td', 'table.conn .conn__row td', [
      'font-size',
      'padding-top',
      'padding-left',
    ]),
    probe('table-row', 'table.conn .conn__row', 'table.conn .conn__row', ['border-bottom-color']),
    probe('legend', '.legend', '[data-section="002"] .legend', [
      'font-family',
      'font-size',
      'color',
      'text-transform',
    ]),
    probe('grants-lede', '.grl__count', '[data-section="006"] .grl__count', TYPE),
    probe('grants-group', '.grl__banner', '[data-section="006"] .grl__banner', [
      'padding-top',
      'padding-left',
      'border-bottom-color',
    ]),
    probe('tripwire-row', '.tw__row', '[data-section="007"] .tw__row', [
      'padding-top',
      'padding-left',
      'border-bottom-color',
    ]),
    probe('night-step', '.nr__step', '[data-section="008"] .nr__step', [
      'padding-top',
      'padding-left',
      'border-bottom-color',
    ]),
  ],
};
