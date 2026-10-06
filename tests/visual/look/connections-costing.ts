// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal section 009, skill costing (PAGE-MAP AGENCY
// "Connections & Signal"). The app numbers skill costing 009; the mockup still
// prints it 012, so each probe names its element by class under the panel
// that holds it, never by number. The other sections are look/connections.ts.

import type { LookProbe, LookScreen } from './probe.ts';

const MOCKUP = '/agency/connections-and-signal/';
const PAGE = 'agency:connections';
const WIDTHS = [1480, 900, 390] as const;

/** One element on both sides, found by the same class under each side's section. */
const probe = (
  id: string,
  selector: string,
  props: readonly string[],
  ruled?: LookProbe['ruled'],
): LookProbe => ({
  id: `connections-costing.${id}`,
  mockup: { path: MOCKUP, selector: `#skcPanel ${selector}` },
  app: { page: PAGE, selector: `[data-costing] ${selector}` },
  props,
  widths: WIDTHS,
  ...(ruled === undefined ? {} : { ruled }),
});

/** DR-10 folded the dark faint ink to 55 percent; the mockup drew 46. */
const FAINT_DARK = [{ at: 'color@dark', want: 'rgba(248,248,248,140)', why: 'DR-10' }] as const;

const INK = ['font-family', 'font-size', 'color'] as const;
const ROW = [
  'display',
  'padding-top',
  'padding-left',
  'border-bottom-width',
  'border-bottom-color',
] as const;

export const CONNECTIONS_COSTING: LookScreen = {
  id: 'connections-costing',
  probes: [
    probe('count', '.skc__count', INK),
    probe('card', '.card', ['border-top-width', 'border-top-color', 'background-color']),
    probe('row', '.skc__row', ROW),
    probe('skill', '.skc__what', INK),
    probe('figure', '.skc__fig', ['display', 'font-family', 'font-size']),
    probe('mean', '.skc__n', [...INK, 'font-variant-numeric']),
    probe('spread', '.skc__spread', ['color']),
    probe('label', '.skc__k', ['color', 'letter-spacing', 'margin-right'], FAINT_DARK),
    probe('observed', '.skc__obs', INK),
    probe('model', '.skc__model', ['color', 'margin-right']),
    probe('foot', '.skc__foot', ['border-top-width', 'border-top-color', 'padding-top']),
    probe('split', '.skc__split', ['display', ...INK]),
  ],
};
