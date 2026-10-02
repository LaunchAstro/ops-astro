// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-23: the task page never draws the burn bar.
//
// MP-4-6 says the burn bar turns danger once logged time passes the estimate,
// and `estimateMinutes` is on the wire (`read-defaults.ts` carries it). But
// `TeamSubtasks` mounts `TimeLog` with `estimateMinutes={null}` hard-coded, so
// the bar has nothing to burn against and is never drawn. The MP-4-6 suite
// hands `TimeLog` the estimate itself, so it does not prove the real mount.
//
// This renders the task page as the API sends it, with an estimate of 60
// minutes and 90 logged, and looks for the danger bar. It passes once
// `TeamSubtasks` passes the task's own `estimateMinutes` to `TimeLog`.

import { afterEach, describe, expect, it } from 'vitest';
import { found, page } from './task-page-stub.tsx';
import { unmountAll } from './perspective-support.tsx';

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

describe('REVIEW-2C1-23 the task page draws the burn bar', () => {
  it('REVIEW-2C1-23: with an estimate of 60 and 90 logged, the task page draws the burn bar in danger', async () => {
    const view = await page('Proj-Verity-Pacing', found({ estimateMinutes: 60, time: NINETY }));
    // Setup proof: the page drew this task's time section with its total.
    const section = view.host.querySelector('[data-time-log-section]');
    expect(section, 'the time section is drawn').not.toBeNull();
    expect(view.host.querySelector('[data-time-total]')?.textContent).toContain('1h 30m');
    // The defect: the estimate on the wire never reaches the time section.
    expect(
      view.host.querySelector('[data-time-burn][data-danger="true"]'),
      'the burn bar is drawn in danger over the estimate',
    ).not.toBeNull();
  });
});
