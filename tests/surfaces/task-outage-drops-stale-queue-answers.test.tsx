// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The outage report re-asks the queue with every live task read, so queue
// answers can cross. The newest ask wins: an older answer that lands after it
// draws nothing, and an answer asked under a business the tab has left draws
// nothing under the next one.

import { act } from 'react';
import { expect, it } from 'vitest';
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

const OUTAGE = {
  id: 'o-old',
  cause: 'provider_unavailable',
  fault: 'provider',
  openedAt: '2026-10-12 08:00:00+00',
  lastDropAt: '2026-10-12 08:01:00+00',
  closedAt: null,
  runs: [{ taskId: TASK_ID, runId: 'run-1', attemptId: 'att-1', reactivated: false }],
};

const TASK = {
  id: TASK_ID,
  key: 'TSK-31',
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

const queue = (outages: readonly unknown[]) =>
  json({ ok: true, queue: [], alerts: [], outages: structuredClone(outages) });

/** One business's server: its queue asks wait until the case answers them, in any order. */
function server(businessKey: string, title: string) {
  const asks: ((outages: readonly unknown[]) => void)[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const fetch = ((url: string | URL) => {
    const at = String(url);
    if (at.includes('/live?')) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    }
    if (at.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (at.endsWith('/task/read')) {
      return Promise.resolve(json({ ok: true, task: { ...TASK, title } }));
    }
    if (at.endsWith('/task/queue')) {
      return new Promise<Response>((resolve) => {
        asks.push((outages) => {
          resolve(queue(outages));
        });
      });
    }
    return Promise.resolve(json({ ok: true }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey, signedIn: true, fetch }),
    asks,
    joined: () => stream !== null,
    answer: async (at: number, outages: readonly unknown[]) => {
      await act(async () => {
        asks[at]?.(outages);
        await pause();
      });
    },
    invalidate: async () => {
      await act(async () => {
        stream?.enqueue(new TextEncoder().encode(`event: invalidate\ndata: task:${TASK_ID}\n\n`));
        await pause();
      });
    },
  };
}

const titleOf = (host: HTMLElement): string =>
  (host.querySelector('#task-title') as HTMLInputElement | null)?.value ?? '';

const soon = (): number => Date.now() + 2_000;

it('an older queue answer landing after a newer one does not bring a closed outage back', async () => {
  const api = server('alpha', 'Dropped');
  const view = await mount(
    <TaskDetailScreen client={api.client} grantKey="alpha:ada" taskKey="TSK-31" />,
  );
  await until('the task and the stream', () => api.joined() && titleOf(view.host) !== '', soon());
  await api.answer(api.asks.length - 1, [OUTAGE]);
  await until('the outage', () => view.find('[data-outage="o-old"]') !== null, soon());
  const older = api.asks.length;
  await api.invalidate();
  await until('an older ask', () => api.asks.length === older + 1, soon());
  await api.invalidate();
  await until('a newer ask', () => api.asks.length === older + 2, soon());
  await api.answer(older + 1, []);
  await until('the outage gone', () => view.find('[data-outage]') === null, soon());
  await api.answer(older, [OUTAGE]);
  await act(async () => {
    await pause();
  });
  expect(view.find('[data-outage]')).toBeNull();
  await view.unmount();
});

it("a business switch with the queue asked draws none of the old business's outages", async () => {
  const alpha = server('alpha', 'Alpha task');
  const bravo = server('bravo', 'Bravo task');
  const view = await mount(
    <TaskDetailScreen client={alpha.client} grantKey="alpha:ada" taskKey="TSK-31" />,
  );
  await until('the task read and its ask', () => titleOf(view.host) !== '', soon());
  await view.render(
    <TaskDetailScreen client={bravo.client} grantKey="bravo:ada" taskKey="TSK-31" />,
  );
  await until('the next business asks', () => bravo.asks.length > 0, soon());
  await Promise.all(alpha.asks.map((_, at) => alpha.answer(at, [OUTAGE])));
  await act(async () => {
    await pause();
  });
  expect(view.find('[data-outage]')).toBeNull();
  await Promise.all(bravo.asks.map((_, at) => bravo.answer(at, [])));
  expect(view.find('[data-outage]')).toBeNull();
  await view.unmount();
});
