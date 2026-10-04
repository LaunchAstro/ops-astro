// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A decision sent on one task can settle after the reader has moved to
// another task and been refused there for want of the grant. The older
// answer is about the task it was sent on, so it leaves the new task's
// closure alone.

import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { refused, taskPage, taskServer, tick } from './task-page-fixture.tsx';

it('a late decision result from the previous task cannot reopen the next task refusal', async () => {
  const client = taskServer(
    { state: 'pending', expired: false },
    { '/task/decide': refused('SCOPE_NOT_GRANTED', 403) },
  );
  type Result = Awaited<ReturnType<typeof client.mutate>>;
  const finish: ((result: Result) => void)[] = [];
  const earlier = new Promise<Result>((resolve) => {
    finish.push(resolve);
  });
  const writes = vi.spyOn(client, 'mutate').mockReturnValueOnce(earlier);
  const page = await taskPage(client);
  try {
    await page.click('[data-decide="approve"]');
    await page.render(<TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-42" />);
    await tick();
    await page.click('#perspective-tab-agent');
    await page.click('[data-gate-action="approve"]');
    await tick();
    expect(writes).toHaveBeenCalledTimes(2);
    expect(page.find('[data-agent="gate-actions"] [data-gate="closed"]')).not.toBeNull();

    await act(async () => {
      finish[0]?.({ unavailable: true, because: 'The earlier decision response was lost.' });
      await earlier;
    });
    await tick();
    expect(page.find('[data-agent="gate-actions"] [data-gate="closed"]')).not.toBeNull();
    expect(page.find('[data-agent="reject"]')?.hasAttribute('disabled')).toBe(true);
  } finally {
    await page.unmount();
  }
});

it('a late decision result from the previous task settling with the next task refusal leaves it closed', async () => {
  const client = taskServer(
    { state: 'pending', expired: false },
    { '/task/decide': refused('SCOPE_NOT_GRANTED', 403) },
  );
  type Result = Awaited<ReturnType<typeof client.mutate>>;
  const real = client.mutate.bind(client);
  const finish: ((result: Result) => void)[] = [];
  const earlier = new Promise<Result>((resolve) => {
    finish.push(resolve);
  });
  const release: (() => void)[] = [];
  const later = new Promise<void>((resolve) => {
    release.push(resolve);
  });
  const writes = vi
    .spyOn(client, 'mutate')
    .mockReturnValueOnce(earlier)
    .mockImplementationOnce(async (...args) => {
      await later;
      return real(...args);
    });
  const page = await taskPage(client);
  try {
    await page.click('[data-decide="approve"]');
    await page.render(<TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-42" />);
    await tick();
    await page.click('#perspective-tab-agent');
    await page.click('[data-gate-action="approve"]');
    await tick();
    expect(writes).toHaveBeenCalledTimes(2);

    // Both answers land in one batch, the older one first.
    await act(async () => {
      finish[0]?.({ unavailable: true, because: 'The earlier decision response was lost.' });
      release[0]?.();
      await earlier;
      await later;
      await tick();
    });
    await tick();
    expect(page.find('[data-agent="gate-actions"] [data-gate="closed"]')).not.toBeNull();
    expect(page.find('[data-agent="reject"]')?.hasAttribute('disabled')).toBe(true);
  } finally {
    await page.unmount();
  }
});
