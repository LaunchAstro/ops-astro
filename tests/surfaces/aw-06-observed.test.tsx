// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-06 on the task page: each run draws its observed layer from the graph
// `task.execution` carries. A quiet run whose lease ran out with no drop
// recorded is still in progress, money nobody recorded reads as not recorded
// (never 0), and nothing says planned or unplanned while the plan is unbound.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let n = 0; n < 3; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- let each read settle in turn
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const TASK = {
  id: '33333333-3333-4333-8333-333333333333',
  key: 'TSK-31',
  title: 'A task with a run',
  description: null,
  state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 7,
  history: [],
  comments: [],
  proposals: [],
};

const run = (runId: string, state: string) => ({
  runId,
  lineageId: 'l-1',
  versionId: `v-${runId}`,
  state,
  taskRevisionAtRequest: 7,
  createdAt: '2026-09-29T01:00:00.000Z',
});

const node = (runId: string, over: Readonly<Record<string, unknown>>) => ({
  nodeId: runId,
  condition: over['condition'],
  planned: null,
  observed: {
    runState: 'claimed',
    attemptId: null,
    whoseMove: null,
    outcome: null,
    fault: null,
    lease: null,
    effectObserved: false,
    heldMinor: null,
    spentMinor: null,
    currency: 'AUD',
    ...over,
  },
});

const EXECUTION = {
  ok: true,
  execution: {
    outcome: 'ready',
    taskId: TASK.id,
    sourceRevision: 0,
    complete: true,
    next: null,
    runs: [run('r-1', 'claimed'), run('r-2', 'planned')],
    events: [],
    graph: {
      plan: 'unbound',
      sourceRevision: 0,
      complete: true,
      nodes: [
        node('r-1', {
          condition: 'in_progress',
          whoseMove: { kind: 'agent', actorId: 'a-1' },
          lease: { state: 'lapsed', expiresAt: '2026-09-30T01:00:00.000Z' },
          heldMinor: 1000,
        }),
        node('r-2', { condition: 'settled', runState: 'planned', outcome: 'refused' }),
      ],
    },
  },
};

function open() {
  const answer = (at: string): Response => {
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return json({ ok: true, task: TASK });
    if (at.endsWith('/task/execution')) return json(EXECUTION);
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
  };
  const fetch = ((url: string | URL) =>
    Promise.resolve(answer(String(url)))) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    token: 'a-token',
    fetch,
    newOperationId: () => 'operation-1',
  });
  return mount(<TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-31" />);
}

describe('AW-06 the observed layer on the task page', () => {
  it('AW-06 observed: each run draws its condition, a lapsed lease with no drop stays in progress, and absent money reads not recorded, never 0', async () => {
    const page = await open();
    await tick();
    const first = page.find('[data-run-id="r-1"] [data-observed]') as HTMLElement | null;
    expect(first?.dataset['observed']).toBe('in_progress');
    expect(first?.textContent).toContain("In progress: the agent's move");
    expect(first?.textContent).toContain('Held 1000 AUD (minor units); spent not recorded.');
    expect(first?.textContent).not.toMatch(/spent 0/u);
    expect(page.find('[data-run-id="r-1"] [data-observed-lease="lapsed"]')).not.toBeNull();
    const second = page.find('[data-run-id="r-2"] [data-observed]') as HTMLElement | null;
    expect(second?.dataset['observed']).toBe('settled');
    expect(second?.textContent).toContain('Settled: refused');
    expect(page.text()).not.toMatch(/unplanned/iu);
    await page.unmount();
  });
});
