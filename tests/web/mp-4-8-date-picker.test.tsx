// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8, the dock task panel's date picker (CS-4.13, DS-PRIM-19): a
// Monday-first month grid, months back and forward without choosing, arrows
// across days and weeks, Enter or a click to choose, and Today, In a week and
// In two weeks counted on the business clock. The due date goes out through
// task.update at the read revision.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { press, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import { panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

// 30 September 15:00 UTC is 1 October in Brisbane: the business's clock, the
// one the rest of the task screens date by, never the machine's UTC day.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-30T15:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

const opened = async (over: Readonly<Record<string, unknown>> = {}) => {
  const served = serving(over);
  const view = await panel(served.client);
  await view.click('[data-panel-field="due"]');
  return { view, sent: served.sent };
};

const dayOf = (view: Awaited<ReturnType<typeof opened>>['view'], selector: string) =>
  view.host.querySelector<HTMLElement>(selector)?.dataset;

describe('MP-4-8 date picker keyboard', () => {
  it('opens on the due date’s month, in a Monday-first grid', async () => {
    const { view } = await opened({ due: '2026-11-18T00:00:00.000Z' });
    expect(view.find('[data-picker-month]')?.textContent).toBe('November 2026');
    expect(
      view.all('[data-date-picker] [role="columnheader"]').map((h) => h.textContent),
    ).toStrictEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
    // 2 November 2026 is a Monday: the first cell of its row.
    const monday = view.find('[data-day="2026-11-02"]');
    expect(
      monday?.closest('[role="row"]')?.querySelector('[role="gridcell"]')?.contains(monday),
    ).toBe(true);
    expect(view.find('[data-day="2026-11-18"]')?.getAttribute('aria-selected')).toBe('true');
    await view.unmount();
  });

  it('with no due date it opens on today’s month by the business clock', async () => {
    const { view } = await opened();
    expect(view.find('[data-picker-month]')?.textContent).toBe('October 2026');
    expect(dayOf(view, '[data-day="2026-10-01"]')?.['today']).toBe('true');
    await view.unmount();
  });

  it('months go back and forward without choosing a day', async () => {
    const { view, sent } = await opened();
    await view.click('[data-picker="next"]');
    expect(view.find('[data-picker-month]')?.textContent).toBe('November 2026');
    await view.click('[data-picker="prev"]');
    await view.click('[data-picker="prev"]');
    expect(view.find('[data-picker-month]')?.textContent).toBe('September 2026');
    expect(sent).toStrictEqual([]);
    expect(view.find('[data-date-picker]')).not.toBeNull();
    await view.unmount();
  });
});

describe('MP-4-8 date picker keyboard', () => {
  it('arrows move across days and weeks without choosing, and Enter chooses', async () => {
    const { view, sent } = await opened();
    const grid = '[data-date-picker] [role="grid"]';
    await press(view, grid, 'ArrowRight');
    await press(view, grid, 'ArrowDown');
    await press(view, grid, 'ArrowDown');
    await press(view, grid, 'ArrowLeft');
    await press(view, grid, 'ArrowUp');
    expect(sent).toStrictEqual([]);
    // 1 Oct +1 day +2 weeks −1 day −1 week = 8 Oct.
    expect(dayOf(view, '[data-day][tabindex="0"]')?.['day']).toBe('2026-10-08');
    await press(view, grid, 'Enter');
    await tick();
    expect(
      sent.map((each) => [each.to, each.body['fields'], each.body['expectedRevision']]),
    ).toStrictEqual([['/task/update', { due: '2026-10-08' }, 4]]);
    expect(view.find('[data-date-picker]')).toBeNull();
    await view.unmount();
  });

  it('an arrow past the month’s edge turns the month', async () => {
    const { view } = await opened();
    await press(view, '[data-date-picker] [role="grid"]', 'ArrowUp');
    expect(view.find('[data-picker-month]')?.textContent).toBe('September 2026');
    expect(dayOf(view, '[data-day][tabindex="0"]')?.['day']).toBe('2026-09-24');
    await view.unmount();
  });
});

describe('MP-4-8 date picker keyboard', () => {
  it.each([
    ['today', '2026-10-01'],
    ['week', '2026-10-08'],
    ['fortnight', '2026-10-15'],
  ])('the quick choice %s is counted from the business clock', async (quick, due) => {
    const { view, sent } = await opened();
    await view.click(`[data-picker-quick="${quick}"]`);
    await tick();
    expect(sent.map((each) => each.body['fields'])).toStrictEqual([{ due }]);
    await view.unmount();
  });

  it('a click on a day chooses it; Clear sends no due date', async () => {
    const { view, sent } = await opened({ due: '2026-10-20T00:00:00.000Z' });
    await view.click('[data-day="2026-10-22"]');
    await tick();
    await view.click('[data-panel-field="due"]');
    await view.click('[data-picker-quick="clear"]');
    await tick();
    expect(sent.map((each) => each.body['fields'])).toStrictEqual([
      { due: '2026-10-22' },
      { due: null },
    ]);
    await view.unmount();
  });
});
