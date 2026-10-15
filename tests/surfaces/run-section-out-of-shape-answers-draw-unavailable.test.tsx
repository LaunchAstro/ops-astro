// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A run section answer out of shape draws as unavailable on the task page,
// never as a throw: an event that is not an object naming its run, and a
// receipt answer that succeeds without its receipt.

import { describe, expect, it } from 'vitest';
import { answer, event, json, open, run, tick } from './t2g-run-progress-fixture.tsx';

describe('a run section answer out of shape', () => {
  it.each([
    ['a null event', [null]],
    ['a number for an event', [7]],
    ['an event without its run', [{ ...event(1, 'r-1', 'picked_up'), runId: undefined }]],
  ])('draws an answer carrying %s as unavailable, never a throw', async (_, events) => {
    const page = await open(answer('ready', [run('r-1', 'running')], events));
    await tick();
    expect((page.find('[data-run-progress]') as HTMLElement | null)?.dataset['outcome']).toBe(
      'unavailable',
    );
    expect(page.all('[data-run-id]')).toHaveLength(0);
    await page.unmount();
  });

  it('a receipt answer without its receipt says the receipt could not be read', async () => {
    const page = await open(
      answer('ready', [run('r-1', 'running')], [event(1, 'r-1', 'claimed')]),
      json({ ok: true }),
    );
    await tick();
    expect(page.find('[data-receipt="unavailable"]')?.textContent).toContain(
      'The receipt for attempt a-1 could not be read.',
    );
    expect(page.find('[data-receipt-decision]')).toBeNull();
    await page.unmount();
  });
});
