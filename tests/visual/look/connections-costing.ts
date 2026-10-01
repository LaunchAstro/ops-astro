// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal sections 009 to 012 (PAGE-MAP AGENCY "Connections &
// Signal"; MP-14-9 skill costing, MP-14-10a the client scope bar and
// graduation). R61 numbers skill costing 009 in the app; the mockup still
// prints it 012, so each probe names its element by class, never by number.
// Sections 001 to 008 are look/connections.ts.

import type { LookProbe, LookScreen } from './index.ts';

const MOCKUP = '/agency/connections-and-signal/';
const PAGE = 'agency:connections';
const WIDTHS = [1480, 900, 390] as const;

/** One element on both sides, found by the same class under each side's section. */
const probe = (
  id: string,
  within: { readonly mockup: string; readonly app: string },
  selector: string,
  props: readonly string[],
  ruled?: LookProbe['ruled'],
): LookProbe => ({
  id: `connections-costing.${id}`,
  mockup: { path: MOCKUP, selector: `${within.mockup} ${selector}` },
  app: { page: PAGE, selector: `${within.app} ${selector}` },
  props,
  widths: WIDTHS,
  ...(ruled === undefined ? {} : { ruled }),
});

/** DR-10 folded the dark faint ink to 55 percent; the mockup drew 46 (SIDEBAR.md DS-SIDE-2). */
const FAINT_DARK = [{ at: 'color@dark', want: 'rgba(248,248,248,140)', why: 'DR-10' }] as const;

const COSTING = { mockup: '#skcPanel', app: '[data-costing]' } as const;
const REGION = { mockup: '#gradPanel', app: '#graduation' } as const;
const SCOPE = { mockup: '#agScopeBar', app: '[data-client-scope]' } as const;
const INK = ['font-family', 'font-size', 'color'] as const;

export const CONNECTIONS_COSTING: LookScreen = {
  id: 'connections-costing',
  probes: [
    probe('count', COSTING, '.skc__count', INK),
    probe('card', COSTING, '.card', ['border-top-width', 'border-top-color', 'background-color']),
    probe('row', COSTING, '.skc__row', [
      'display',
      'padding-top',
      'padding-left',
      'border-bottom-width',
      'border-bottom-color',
    ]),
    probe('skill', COSTING, '.skc__what', INK),
    probe('figure', COSTING, '.skc__fig', ['display', 'font-family', 'font-size']),
    probe('mean', COSTING, '.skc__n', [...INK, 'font-variant-numeric']),
    probe('spread', COSTING, '.skc__spread', ['color']),
    probe('label', COSTING, '.skc__k', ['color', 'letter-spacing', 'margin-right'], FAINT_DARK),
    probe('observed', COSTING, '.skc__obs', INK),
    probe('model', COSTING, '.skc__model', ['color', 'margin-right']),
    probe('foot', COSTING, '.skc__foot', ['border-top-width', 'border-top-color', 'padding-top']),
    probe('split', COSTING, '.skc__split', ['display', ...INK]),
    probe(
      'scope-label',
      SCOPE,
      '.gradbar__l',
      ['font-size', 'text-transform', 'letter-spacing', 'color'],
      FAINT_DARK,
    ),
    probe('scope-note', SCOPE, '.approval__meta', INK),
    probe('grad-card', REGION, '.card--flush', ['border-top-width', 'background-color']),
    probe('grad-row', REGION, '.grad__row', [
      'display',
      'padding-top',
      'padding-left',
      'border-bottom-width',
      'border-bottom-color',
    ]),
    probe('grad-name', REGION, '.grad__name b', ['font-size', 'font-weight', 'color']),
    probe('grad-type', REGION, '.grad__type', [...INK, 'letter-spacing'], FAINT_DARK),
    probe('switch', REGION, '.autosw', [
      'box.width',
      'box.height',
      'border-top-color',
      'background-color',
    ]),
    probe('knob', REGION, '.autosw__k', ['box.width', 'border-top-color', 'background-color']),
    probe('switch-said', REGION, '.autosw__lbl', ['font-size', 'color']),
    probe('count-n', REGION, '.grad__n b', INK),
    probe('grad-note', REGION, '.grad__note', ['font-size', 'color']),
    probe('mandate', REGION, '.ps', [
      'border-left-width',
      'border-left-color',
      'padding-left',
      'background-color',
    ]),
    probe('mandate-text', REGION, '.ps__text', ['font-size', 'color']),
    probe(
      'mandate-meta',
      REGION,
      '.ps__meta',
      ['font-size', 'text-transform', 'color'],
      FAINT_DARK,
    ),
  ],
};
