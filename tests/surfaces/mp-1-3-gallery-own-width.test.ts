// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-3: the gallery draws each component at the width it has in a page. A
// state laid out as a stretching grid widened every control to its label (the
// secondary button 65.34 px against its own 61.09 px, as the mockup draws it),
// so the local mockup comparison saw a wider button than the kit draws. The
// browser half reads the drawn gallery at 1480, 900 and 390 in both themes
// (mp-1-3-gallery-own-width.ts).

import { beforeAll, describe, expect, it } from 'vitest';
import { runLeg } from './browser-leg.ts';
import { CHOSEN, type WidthView } from './mp-1-3-gallery-own-width.ts';

let views: WidthView[] = [];

beforeAll(() => {
  views = runLeg<WidthView[]>('mp-1-3-gallery-own-width.ts');
  expect(views).toHaveLength(6);
}, 900_000);

const kindOf = (unit: string, state: string): string =>
  CHOSEN.find((chosen) => chosen.unit === unit && chosen.state === state)?.kind ?? '';

describe('MP-1-3 the gallery draws components at their page width', () => {
  it('MP-1-3 a button or chip in the gallery draws at its own width, not its label', () => {
    for (const view of views) {
      const inline = view.measured.filter((m) => kindOf(m.unit, m.state) === 'inline');
      expect(inline, view.name).toHaveLength(4);
      for (const m of inline) {
        expect(m.drawn, `${view.name} ${m.unit} ${m.state}`).toBeGreaterThan(0);
        expect(Math.abs(m.drawn - m.own), `${view.name} ${m.unit} ${m.state}`).toBeLessThan(0.02);
      }
      const secondary = inline.find((m) => m.state === 'Secondary');
      expect(secondary?.drawn, view.name).toBeLessThan(secondary?.stateWidth ?? 0);
    }
  });

  it('MP-1-3 a banner, field, meter, sample mark or axis chart still fills its state', () => {
    for (const view of views) {
      const blocks = view.measured.filter((m) => kindOf(m.unit, m.state) === 'block');
      expect(blocks, view.name).toHaveLength(5);
      for (const m of blocks) {
        expect(m.drawn, `${view.name} ${m.unit} ${m.state}`).toBeGreaterThan(0);
        expect(Math.abs(m.drawn - m.stateWidth), `${view.name} ${m.unit} ${m.state}`).toBeLessThan(
          0.02,
        );
      }
    }
  });
});
