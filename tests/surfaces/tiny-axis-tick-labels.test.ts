// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { axisTicks, formatTick } from '../../packages/ui/src/kit/charts.tsx';

it('MP-1-5 tiny axis ticks retain distinct readable labels', () => {
  const ticks = axisTicks(0, 1e-7);
  const labels = ticks.map((tick) => formatTick(tick, ticks));
  expect(new Set(labels).size).toBe(labels.length);
  expect(labels.at(-1)).not.toBe('0');
});
