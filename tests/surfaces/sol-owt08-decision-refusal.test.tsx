// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// One refused decision closes every decide control on the task (catalogue #584).
//
// The task page draws a gate twice: the gate card under the proposals and the
// Agent pane's gate box. `SCOPE_NOT_GRANTED` is about the reader, not the
// version, so whichever view was refused, neither may ask again on the
// reader's behalf. Sol's proof (OWT-08.2) refuses the task page's control and
// presses the pane's; the second case refuses the pane's and presses the
// task page's.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tick, refused, taskServer, taskPage } from './task-page-fixture.tsx';

// The history says how long ago each change was (MP-4-16), so the reader's
// clock is fixed here: a pin that moved every day would pin nothing. Only
// Date is faked; the timers the page waits on stay real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

it('Sol proof, criterion 7: every approval control stays closed after a refused decision', async () => {
  const client = taskServer(
    { state: 'pending', expired: false },
    { '/task/decide': refused('SCOPE_NOT_GRANTED', 403) },
  );
  const writes = vi.spyOn(client, 'mutate');
  const page = await taskPage(client);
  try {
    await page.click('#perspective-tab-agent');
    await page.click('[data-decide="approve"]');
    await tick();
    expect(page.text()).toContain('The server refused your decision on this gate');
    expect(writes).toHaveBeenCalledTimes(1);
    expect(page.find('[data-agent="gate-actions"] [data-gate="closed"]')).not.toBeNull();
    const other = page.find('[data-gate-action="approve"]');
    if (other !== null && !other.hasAttribute('disabled')) {
      await page.click('[data-gate-action="approve"]');
    }
    await tick();
    expect(
      writes,
      'the second view must honour the held refusal for the same gate',
    ).toHaveBeenCalledTimes(1);
  } finally {
    await page.unmount();
  }
});

it('a decision refused from the Agent pane closes the task page decide controls too', async () => {
  const client = taskServer(
    { state: 'pending', expired: false },
    { '/task/decide': refused('SCOPE_NOT_GRANTED', 403) },
  );
  const writes = vi.spyOn(client, 'mutate');
  const page = await taskPage(client);
  try {
    await page.click('#perspective-tab-agent');
    await page.click('[data-gate-action="approve"]');
    await tick();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(page.find('[data-agent="gate-actions"] [data-gate="closed"]')).not.toBeNull();
    expect(page.find('[data-decide="approve"]')).toBeNull();
    expect(page.find('[data-decide="closed"]')?.textContent).toContain(
      'The server refused your decision on this gate',
    );
  } finally {
    await page.unmount();
  }
});
