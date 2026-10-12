// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The outage report on an open task page follows the task's live re-reads. A
// provider drop invalidates the task, and the re-read keeps the page mounted,
// so the queue the report comes from is asked again with it: a new outage
// shows with no reload, and an open one's counts move on.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const TASK_ID = '33333333-3333-4333-8333-333333333333';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

async function until(say: string, check: () => boolean, deadline: number): Promise<void> {
  if (check()) return;
  if (Date.now() > deadline) throw new Error(`never happened: ${say}`);
  await act(async () => {
    await pause();
  });
  return until(say, check, deadline);
}

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

/** A task, its team's outage queue and a live stream the case writes into. */
function server() {
  const task = {
    id: TASK_ID,
    key: 'TSK-31',
    title: 'Before the drop',
    description: null,
    state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 1,
    history: [],
    comments: [],
    proposals: [],
  };
  const outages: unknown[] = [];
  let holdQueue = false;
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const fetch = (async (url: string | URL) => {
    const at = String(url);
    if (at.includes('/live?')) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return json({ ok: true, task: { ...task } });
    if (at.endsWith('/task/queue')) {
      if (holdQueue) {
        return new Promise<Response>(() => {
          /* held */
        });
      }
      return json({ ok: true, queue: [], alerts: [], outages: structuredClone(outages) });
    }
    return json({ ok: true });
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    task,
    outages,
    joined: () => stream !== null,
    holdQueue: () => {
      holdQueue = true;
    },
    invalidate: async () => {
      await act(async () => {
        stream?.enqueue(new TextEncoder().encode(`event: invalidate\ndata: task:${TASK_ID}\n\n`));
        await pause();
      });
    },
  };
}

const outage = (runs: readonly ReturnType<typeof run>[]) => ({
  id: 'o-new',
  cause: 'provider_unavailable',
  fault: 'provider',
  openedAt: '2026-10-12 08:00:00+00',
  lastDropAt: '2026-10-12 08:01:00+00',
  closedAt: null,
  runs,
});

const titleOf = (host: HTMLElement): string =>
  (host.querySelector('#task-title') as HTMLInputElement | null)?.value ?? '';

describe('the outage report on a live task page', () => {
  it('shows a new outage after the live re-read, with no reload', async () => {
    const api = server();
    const view = await mount(
      <TaskDetailScreen client={api.client} grantKey="alpha:ada" taskKey="TSK-31" />,
    );
    await until(
      'the task and the stream',
      () => api.joined() && titleOf(view.host) !== '',
      Date.now() + 2_000,
    );
    expect(view.find('[data-outage]')).toBeNull();

    api.outages.push(outage([run(TASK_ID, false)]));
    api.task.title = 'Dropped by the provider';
    await api.invalidate();
    await until('the new title', () => titleOf(view.host) === api.task.title, Date.now() + 2_000);
    await until(
      'the outage',
      () => view.find('[data-outage="o-new"]') !== null,
      Date.now() + 2_000,
    );
    await view.unmount();
  });

  it('moves an open outage on with the live re-read', async () => {
    const api = server();
    api.outages.push(outage([run(TASK_ID, false)]));
    const view = await mount(
      <TaskDetailScreen client={api.client} grantKey="alpha:ada" taskKey="TSK-31" />,
    );
    await until(
      'the outage',
      () => view.find('[data-outage="o-new"]') !== null,
      Date.now() + 2_000,
    );
    expect(view.find('[data-outage="o-new"]')?.textContent).toContain(
      '1 runs dropped, 0 came back',
    );

    api.outages.splice(0, 1, outage([run(TASK_ID, true), run('t-2', false)]));
    api.task.title = 'Back from the drop';
    await api.invalidate();
    await until('the new title', () => titleOf(view.host) === api.task.title, Date.now() + 2_000);
    await until(
      'the moved counts',
      () =>
        (view.find('[data-outage="o-new"]')?.textContent ?? '').includes(
          '2 runs dropped, 1 came back',
        ),
      Date.now() + 2_000,
    );
    await view.unmount();
  });
  it('keeps the report drawn while the queue is asked again', async () => {
    const api = server();
    api.outages.push(outage([run(TASK_ID, false)]));
    const view = await mount(
      <TaskDetailScreen client={api.client} grantKey="alpha:ada" taskKey="TSK-31" />,
    );
    await until(
      'the outage',
      () => view.find('[data-outage="o-new"]') !== null,
      Date.now() + 2_000,
    );
    api.holdQueue();
    api.task.title = 'Still dropped';
    await api.invalidate();
    await until('the new title', () => titleOf(view.host) === api.task.title, Date.now() + 2_000);
    expect(view.find('[data-outage="o-new"]')?.textContent).toContain(
      '1 runs dropped, 0 came back',
    );
    await view.unmount();
  });
});
