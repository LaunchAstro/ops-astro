// SPDX-License-Identifier: AGPL-3.0-only
//
// T2g's shared fixture: the task page on one made-up task, its run read
// from `task.execution` and each attempt's receipt from `task.receipt`.

import { act } from 'react';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

export const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const TASK = {
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

export const run = (runId: string, state: string) => ({
  runId,
  lineageId: 'l-1',
  versionId: 'v-1',
  state,
  taskRevisionAtRequest: 7,
  createdAt: '2026-09-29T01:00:00.000Z',
});

export const event = (position: number, runId: string, kind: string) => ({
  eventId: `e-${String(position)}`,
  runId,
  position,
  kind,
  leaseId: 'lease-1',
  attemptId: 'a-1',
  actorId: 'agent-1',
  detail: {},
  at: '2026-09-29T01:00:00.000Z',
});

export const RECEIPT = new Response(
  JSON.stringify({
    ok: true,
    receipt: {
      attemptId: 'a-1',
      taskId: TASK.id,
      decision: {
        id: 'd-1',
        gateId: 'g-1',
        decidedByPersonId: 'p-mia',
        decidedAt: '2026-09-29T01:00:00Z',
      },
      version: { id: 'v-1', number: 2 },
      effect: { kind: 'comment', operationId: 'op-1', commentId: 'c-1', audience: 'internal' },
      settlement: { state: 'settled', heldMinor: 2000, spentMinor: 1500, releasedMinor: 500 },
    },
  }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

export type Execution = (() => Promise<Response> | Response) | Response;

export function open(execution: Execution, receipt: Response = RECEIPT) {
  const fetch = (async (url: string | URL) => {
    const at = String(url);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return json({ ok: true, task: TASK });
    if (at.endsWith('/task/receipt')) return receipt.clone();
    if (at.endsWith('/task/execution')) {
      return typeof execution === 'function' ? await execution() : execution.clone();
    }
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => 'operation-1',
  });
  return mount(<TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-31" />);
}

export const answer = (
  outcome: string,
  runs: unknown[] = [],
  events: unknown[] = [],
  graph?: unknown,
) =>
  json({
    ok: true,
    execution: {
      outcome,
      taskId: TASK.id,
      sourceRevision: events.length,
      complete: true,
      next: null,
      runs,
      events,
      ...(graph === undefined ? {} : { graph }),
    },
  });

export const drawn = async (execution: Execution): Promise<string | null> => {
  const page = await open(execution);
  await tick();
  const outcome =
    (page.find('[data-run-progress]') as HTMLElement | null)?.dataset['outcome'] ?? null;
  await page.unmount();
  return outcome;
};
