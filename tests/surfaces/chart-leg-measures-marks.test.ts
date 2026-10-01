// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { SHAPES } from './mp-1-5-gallery-charts.ts';

it('MP-1-5 the browser leg measures chart marks rather than their wrappers', () => {
  expect(SHAPES.dial[2]).toContain('chart__ring');
  expect(SHAPES.sparkline[2]).toContain('chart__line');
  expect(SHAPES.funnel[2]).toContain('funnel__bg');
});
