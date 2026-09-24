// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, lane FR2-RUNTIME continuation: R2-RUNTIME-14 on the
// web. The server refuses `task.start` on a completed task with
// TRANSITION_NOT_PERMITTED (a completed task is reopened first, with a
// reason), and the task page offered Start there anyway.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { Lifecycle } from '../../apps/web/src/screens/task/Lifecycle.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const TASK_ID = '55555555-5555-4555-8555-555555555555';

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** A client whose task is in `category`, completed when that category is. */
function clientFor(category: 'unstarted' | 'started' | 'completed'): OperationsClient {
  const task = {
    id: TASK_ID,
    key: 'TSK-14',
    title: 'A task in one lifecycle category',
    description: null,
    state: { id: 's1', key: category, label: category, machineCategory: category },
    assignee: null,
    due: null,
    priority: null,
    completedAt: category === 'completed' ? '2026-09-24T00:00:00.000Z' : null,
    revision: 3,
    history: [],
    comments: [],
    proposals: [],
  };
  const fetch = (async (url: string | URL) => {
    const at = String(url);
    if (at.endsWith('person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('task/read')) return json({ ok: true, task });
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    token: 'a-token',
    fetch,
    newOperationId: () => 'operation-1',
  });
}

async function startButton(category: 'unstarted' | 'started' | 'completed') {
  const page = await mount(
    <TaskDetailScreen client={clientFor(category)} grantKey="alpha:ada" taskKey="TSK-14" />,
  );
  await tick();
  const start = page.find('[data-lifecycle="start"]') as HTMLButtonElement | null;
  const reopen = page.find('[data-lifecycle="reopen"]') as HTMLButtonElement | null;
  return { page, start, reopen };
}

describe('R2-RUNTIME-14: Start on a completed task', () => {
  // Red at ef02a40 and still red here: the page renders `<Lifecycle>` without
  // saying the task is completed (TaskDetail.tsx:575, not this lane's file).
  // Pinned as a known failure so the one-line fix there must flip it to `it`.
  it.fails('is not offered on the task page; Reopen is', async () => {
    const { page, start, reopen } = await startButton('completed');
    expect(start).not.toBeNull();
    expect(start?.disabled).toBe(true);
    expect(reopen?.disabled).toBe(false);
    await page.unmount();
  });

  it('is still offered on a task that is not completed', async () => {
    for (const category of ['unstarted', 'started'] as const) {
      // eslint-disable-next-line no-await-in-loop
      const { page, start } = await startButton(category);
      expect(start?.disabled, category).toBe(false);
      // eslint-disable-next-line no-await-in-loop
      await page.unmount();
    }
  });

  it('the Lifecycle control disables Start for a completed task, and says why', async () => {
    const page = await mount(
      <Lifecycle
        disabled={false}
        completed
        onLifecycle={() => {
          throw new Error('Start is not pressable here');
        }}
      />,
    );
    const start = page.find('[data-lifecycle="start"]') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toBe('A completed task is reopened first.');
    await page.unmount();
  });
});
