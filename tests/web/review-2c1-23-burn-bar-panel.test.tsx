// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-23 beside the proof: the dock task panel mounts the same
// `TeamSubtasks` as the task page, so it draws the burn bar from the task's own
// estimate too. An estimate of 60 with 90 logged is in danger; with no
// estimate there is nothing to burn against and no bar.

import { afterEach, describe, expect, it } from 'vitest';
import { unmountAll } from './perspective-support.tsx';
import { panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

const NINETY = {
  entries: [
    {
      id: 'e-90',
      startedAt: '2026-09-30T01:00:00.000Z',
      endedAt: '2026-09-30T02:30:00.000Z',
      minutes: 90,
      note: '',
      adHoc: false,
      source: 'log',
    },
  ],
  running: null,
  totalMinutes: 90,
};

describe('REVIEW-2C1-23 the task panel draws the burn bar', () => {
  it('with an estimate of 60 and 90 logged, the panel draws the burn bar in danger', async () => {
    const view = await panel(serving({ estimateMinutes: 60, time: NINETY }).client);
    expect(view.find('[data-time-total]')?.textContent).toContain('1h 30m');
    expect(view.find('[data-time-burn][data-danger="true"]')).not.toBeNull();
    await view.unmount();
  });

  it('with no estimate the panel draws no burn bar', async () => {
    const view = await panel(serving({ estimateMinutes: null, time: NINETY }).client);
    expect(view.find('[data-time-total]')?.textContent).toContain('1h 30m');
    expect(view.find('[data-time-burn]')).toBeNull();
    await view.unmount();
  });
});
