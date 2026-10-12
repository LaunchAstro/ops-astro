// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A meter past its target, such as 50 hours of 40, reports a current value
// inside the range it declares to a screen reader, and the page still shows
// the real figure as text.

import { afterEach, expect, it } from 'vitest';
import { PageMeter, Stat } from '../../packages/ui/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** Each meter's value against the range it declares. */
function ranges(view: Mounted): string[] {
  return view.all('[role="meter"]').map((meter) => {
    const [now, min, max] = ['aria-valuenow', 'aria-valuemin', 'aria-valuemax'].map((name) =>
      Number(meter.getAttribute(name)),
    );
    return `${String(now)} in ${String(min)}..${String(max)}`;
  });
}

it('an over-target page meter reports its value within its range and shows 50 of 40', async () => {
  mounted = await mount(<PageMeter label="Hours used" value={50} max={40} />);
  expect(ranges(mounted)).toEqual(['40 in 0..40']);
  expect(mounted.find('.pmeter__val')?.textContent).toBe('50 of 40');
});

it('an over-target tracked stat reports its value within its range and shows 50 of 40', async () => {
  mounted = await mount(<Stat label="Hours used" value={50} of={40} track />);
  expect(ranges(mounted)).toEqual(['40 in 0..40']);
  expect(mounted.find('.stat__num')?.textContent).toBe('50 of 40');
});
