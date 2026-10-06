// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal (PAGE-MAP AGENCY "Connections & Signal"): the fleet and
// the signal sections, then the per-client region below the scope bar, whose
// graduation rows, standing approvals, channels and exceptions are the
// mockup's. The costing section is its own look. The mockup numbers skill
// costing 012 where the product numbers it 009, so each probe names its
// element by class under the panel that holds it, never by section number.

import type { LookProbe, LookScreen } from './probe.ts';

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
const ROW = [
  'display',
  'padding-top',
  'padding-left',
  'border-bottom-width',
  'border-bottom-color',
] as const;

// DR-10 folded the dark muted ink to 55 percent; the mockup drew 46.
const FAINT_DARK = [{ at: 'color@dark', want: 'rgba(248,248,248,140)', why: 'DR-10' }] as const;

// R53 (TOKENS.md census): each text snaps to its canonical type style, so
// where the mockup drew off the scale the build holds the style's value.
const snapped = (prop: string, want: string) =>
  (['light', 'dark'] as const).map((theme) => ({ at: `${prop}@${theme}`, want, why: 'R53' }));

/** One element of the per-client region: the same class under each side's panel. */
const region = (
  id: string,
  panel: { readonly mockup: string; readonly app: string },
  selector: string,
  props: readonly string[],
  more: Partial<LookProbe> = {},
): LookProbe => probe(id, `${panel.mockup} ${selector}`, `${panel.app} ${selector}`, props, more);

// The promote form opens from the first row that can be promoted. The mockup
// has no such form (it asks in a prompt), so its mandate form stands in for the
// element and each value is the build's own: at 390 every field takes the whole
// row, wide enough to read, and the buttons end inside the form.
const PROMOTE = [
  ['promote-form', '[data-promote-form]', { 'box.x': '41', 'box.width': '308' }],
  ['promote-ceiling', '[data-promote-ceiling]', { 'box.width': '308' }],
  ['promote-expiry', '[data-promote-expiry]', { 'box.width': '308' }],
  ['promote-confirm', '[data-promote-confirm]', { 'box.x': '41' }],
] as const;
const promoteProbe = (
  id: string,
  selector: string,
  want: Readonly<Record<string, string>>,
): LookProbe => {
  const base = probe(
    id,
    '#gradPanel .psadd > input',
    `#graduation ${selector}`,
    Object.keys(want),
    {
      widths: [390],
      ruled: (['light', 'dark'] as const).flatMap((theme) =>
        Object.entries(want).map(([prop, value]) => ({
          at: `${prop}@${theme}`,
          want: value,
          why: 'the mockup draws no promote form',
        })),
      ),
    },
  );
  return { ...base, app: { ...base.app, open: '#graduation [data-grad="g-1"] [data-auto]' } };
};

const SCOPE = { mockup: '#agScopeBar', app: '[data-client-scope]' } as const;
const GRAD = { mockup: '#gradPanel', app: '#graduation' } as const;
const CHAN = { mockup: '#chanPanel', app: '[data-mock="channels"]' } as const;
const EXC = { mockup: '#excPanel', app: '[data-mock="exceptions"]' } as const;

export const CONNECTIONS: LookScreen = {
  id: 'connections',
  probes: [
    probe('fleet-banner', '#fleetBanner .banner--bad', '[data-fleet-banner] .banner--bad', [
      'background-color',
      'border-top-color',
      'padding-top',
      'padding-left',
    ]),
    // At 390 the banner's action stays inside the page: one body that grows,
    // then the button, as the mockup draws it.
    probe(
      'fleet-fix',
      '#fleetBanner .banner--bad > .btn',
      '[data-fleet-banner] [data-fleet-fix]',
      ['box.x', 'box.width', 'box.height'],
      { widths: [390] },
    ),
    probe('facet', '#connCtrls .facet', '[data-section="002"] .facet', [
      'color',
      'background-color',
      'border-top-color',
      'padding-left',
      'box.height',
    ]),
    probe('table-cell', 'table.conn .conn__row td', 'table.conn .conn__row td', [
      'padding-top',
      'padding-left',
    ]),
    probe('table-row', 'table.conn .conn__row', 'table.conn .conn__row', ['border-bottom-color']),
    // The lead is the subheading style: 16px medium display where the mockup drew 18px.
    probe('grants-lede', '.grl__count', '[data-section="006"] .grl__lede', TYPE, {
      ruled: [
        ...snapped('font-family', 'Funnel Display'),
        ...snapped('font-size', '16px'),
        ...snapped('font-weight', '500'),
      ],
    }),
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

    // The scope bar, then 010 Graduation and its standing approvals.
    // The label is the eyebrow style: mono light where the mockup drew sans regular.
    region('scope-label', SCOPE, '.gradbar__l', LABEL, {
      ruled: [
        ...FAINT_DARK,
        ...snapped('font-family', 'Chivo Mono'),
        ...snapped('font-weight', '300'),
      ],
    }),
    region('scope-note', SCOPE, '.approval__meta', TYPE),
    region('grad-row', GRAD, '.grad__row', ROW),
    region('grad-type', GRAD, '.grad__type', TYPE, { ruled: FAINT_DARK }),
    region('switch', GRAD, '.autosw', [
      'box.width',
      'box.height',
      'border-top-color',
      'background-color',
    ]),
    region('knob', GRAD, '.autosw__k', ['box.width', 'border-top-color', 'background-color']),
    // A held-by label carries a mandate's id, a UUID that has no space to break at.
    region('switch-said', GRAD, '.autosw__lbl', ['font-size', 'color', 'overflow-wrap'], {
      ruled: (['light', 'dark'] as const).map((theme) => ({
        at: `overflow-wrap@${theme}`,
        want: 'anywhere',
        why: 'a held-by id is a UUID',
      })),
    }),
    region('count-n', GRAD, '.grad__n b', TYPE),
    region('grad-note', GRAD, '.grad__note', ['font-size', 'color']),
    region('mandate', GRAD, '.ps', [
      'border-left-width',
      'border-left-color',
      'padding-left',
      'background-color',
    ]),
    ...PROMOTE.map(([id, selector, want]) => promoteProbe(id, selector, want)),
    region('mandate-text', GRAD, '.ps__text', ['font-size', 'color']),
    region('mandate-meta', GRAD, '.ps__meta', ['font-size', 'text-transform', 'color'], {
      ruled: FAINT_DARK,
    }),

    // 011 Channels and 012 Exceptions, drawn from made-up rows.
    region('chan-row', CHAN, '.chan__row', ROW),
    region('chan-where', CHAN, '.chan__where', [...TYPE, 'letter-spacing'], { ruled: FAINT_DARK }),
    region('chan-note', CHAN, '.chan__note', ['font-size', 'color', 'margin-top']),
    region('exc-row', EXC, '.exc__row', ROW),
    region('exc-where', EXC, '.exc__where', [...TYPE, 'letter-spacing'], { ruled: FAINT_DARK }),
    region('exc-why', EXC, '.exc__why', ['font-size', 'color', 'margin-top']),
    region('exc-meta', EXC, '.exc__meta', ['font-size', 'text-transform', 'color'], {
      ruled: FAINT_DARK,
    }),
  ],
};
