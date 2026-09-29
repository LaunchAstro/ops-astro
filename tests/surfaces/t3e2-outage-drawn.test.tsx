// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// T3e2 on the task page: the one report of the outage that dropped this
// task's work, from the team's queue read: the cause in the drop's words,
// whose fault, the window and how many runs came back. A report that does not
// name this task is not drawn, and a queue read refused draws nothing.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const TASK_ID = '77777777-7777-4777-8777-777777777777';

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
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const run = (taskId: string, reactivated: boolean) => ({
  taskId,
  runId: `run-${taskId}`,
  attemptId: `att-${taskId}`,
  reactivated,
});

function client(queue: 'ok' | 'refused'): OperationsClient {
  const task = {
    id: TASK_ID,
    key: 'TSK-71',
    title: 'A task an outage dropped',
    description: null,
    state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 4,
    history: [],
    comments: [],
    proposals: [],
  };
  const outages = [
    {
      id: 'o-mine',
      cause: 'provider_unavailable',
      fault: 'provider',
      openedAt: '2026-09-29 08:00:00+00',
      lastDropAt: '2026-09-29 08:02:00+00',
      closedAt: null,
      runs: [run(TASK_ID, true), run('t-2', true), run('t-3', false)],
    },
    {
      id: 'o-other',
      cause: 'worker_lost',
      fault: 'ours',
      openedAt: '2026-09-29 07:00:00+00',
      lastDropAt: '2026-09-29 07:00:00+00',
      closedAt: '2026-09-29 07:00:00+00',
      runs: [run('t-9', true)],
    },
  ];
  const answer = (url: string | URL): Response => {
    const at = String(url);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return json({ ok: true, task });
    if (at.endsWith('/task/queue')) {
      return queue === 'ok'
        ? json({ ok: true, queue: [], alerts: [], outages })
        : new Response(
            JSON.stringify({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          );
    }
    return json({ ok: true });
  };
  const fetch = ((url: string | URL) =>
    Promise.resolve(answer(url))) as unknown as typeof globalThis.fetch;
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    token: 'a-token',
    fetch,
    newOperationId: () => 'operation-1',
  });
}

describe('the outage on the task page', () => {
  it('draws the one report naming this task, and not the others', async () => {
    const page = await mount(
      <TaskDetailScreen client={client('ok')} grantKey="alpha:ada" taskKey="TSK-71" />,
    );
    await tick();
    const mine = page.find('[data-outage="o-mine"]')?.textContent ?? '';
    expect(mine).toContain('Dropped — the provider did not answer');
    expect(mine).toContain("the provider's fault");
    expect(mine).toContain('still open');
    expect(mine).toContain('3 runs dropped, 2 came back');
    expect(mine).not.toMatch(/cancel/iu);
    expect(page.find('[data-outage="o-other"]')).toBeNull();
  });

  it('draws nothing when the queue read is refused', async () => {
    const page = await mount(
      <TaskDetailScreen client={client('refused')} grantKey="alpha:ada" taskKey="TSK-71" />,
    );
    await tick();
    expect(page.find('[data-outages]')).toBeNull();
  });
});
