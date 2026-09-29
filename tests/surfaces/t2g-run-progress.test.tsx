// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// T2g, the run on the task page (product issue 15). The run's progress comes
// from `task.execution`, and its six read outcomes (loading, no run, denied,
// unavailable, stale, ready) each draw differently: an empty list never
// answers a denied, failed or unavailable read. Each run is drawn on its own,
// never merged, and a state the projection does not know prints raw at the
// waiting tone.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
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
  versionId: 'v-1',
  state,
  taskRevisionAtRequest: 7,
  createdAt: '2026-09-29T01:00:00.000Z',
});

const event = (position: number, runId: string, kind: string) => ({
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

const RECEIPT = new Response(
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

type Execution = (() => Promise<Response> | Response) | Response;

function open(execution: Execution) {
  const fetch = (async (url: string | URL) => {
    const at = String(url);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return json({ ok: true, task: TASK });
    if (at.endsWith('/task/receipt')) return RECEIPT.clone();
    if (at.endsWith('/task/execution')) {
      return typeof execution === 'function' ? await execution() : execution.clone();
    }
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    token: 'a-token',
    fetch,
    newOperationId: () => 'operation-1',
  });
  return mount(<TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-31" />);
}

const answer = (outcome: string, runs: unknown[] = [], events: unknown[] = []) =>
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
    },
  });

const drawn = async (execution: Execution): Promise<string | null> => {
  const page = await open(execution);
  await tick();
  const outcome =
    (page.find('[data-run-progress]') as HTMLElement | null)?.dataset['outcome'] ?? null;
  await page.unmount();
  return outcome;
};

describe('T2g the run on the task page', () => {
  it('draws each of the six read outcomes differently', async () => {
    const seen = [
      await drawn(
        () =>
          new Promise<Response>(() => {
            /* never answers */
          }),
      ),
      await drawn(answer('no-run')),
      await drawn(
        json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: ['Ask'] }, 403),
      ),
      await drawn(() => Promise.reject(new Error('the network is down'))),
      await drawn(answer('stale', [run('r-1', 'running')])),
      await drawn(answer('ready', [run('r-1', 'running')], [event(1, 'r-1', 'picked_up')])),
    ];
    expect(seen).toStrictEqual(['loading', 'no-run', 'denied', 'unavailable', 'stale', 'ready']);
  });

  it.each([
    [
      'denied',
      () => json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: ['Ask'] }, 403),
    ],
    ['unavailable', () => Promise.reject(new Error('the network is down'))],
  ] as const)('never answers a %s read with an empty run list', async (_, execution) => {
    const page = await open(execution);
    await tick();
    expect(page.find('[data-run-progress] [data-voice="no-rows"]')).toBeNull();
    expect(page.all('[data-run-id]')).toHaveLength(0);
    await page.unmount();
  });

  it('draws every run on its own, and an unknown state raw at the waiting tone', async () => {
    const page = await open(
      answer(
        'ready',
        [run('r-1', 'running'), run('r-2', 'a_state_nobody_named')],
        [event(1, 'r-1', 'picked_up'), event(2, 'r-2', 'handed_back')],
      ),
    );
    await tick();
    expect(page.all('[data-run-id]').map((node) => node.getAttribute('data-run-id'))).toEqual([
      'r-1',
      'r-2',
    ]);
    const unknown = page.find('[data-run-id="r-2"] .spill');
    expect(unknown?.textContent).toBe('a_state_nobody_named');
    expect(unknown?.getAttribute('data-tone')).toBe('wait');
    expect(unknown?.getAttribute('data-state-reference')).toBe('unknown');
    expect(page.find('[data-run-id="r-1"] [data-event-kind="picked_up"]')).not.toBeNull();
    await page.unmount();
  });

  it('draws the receipt: the approval it came from, the effect, and held, spent and released', async () => {
    const page = await open(answer('ready', [run('r-1', 'running')], [event(1, 'r-1', 'claimed')]));
    await tick();
    const receipt = page.find('[data-run-id="r-1"] [data-receipt-attempt="a-1"]');
    expect(receipt?.getAttribute('data-receipt-decision')).toBe('d-1');
    expect(receipt?.textContent).toContain('version 2');
    expect(receipt?.textContent).toContain('team-only comment');
    const money = page.find('[data-receipt-attempt="a-1"] [data-money]');
    expect(money?.textContent).toBe('held 20.00 · spent 15.00 · released 5.00');
    expect(page.find('[data-receipt-attempt="a-1"] button')).toBeNull();
    await page.unmount();
  });

  it('the task page reaches a run event after the first execution page', async () => {
    const cursors: unknown[] = [];
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      const at = String(url);
      if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
      if (at.endsWith('/task/read')) return json({ ok: true, task: TASK });
      if (at.endsWith('/task/receipt')) return RECEIPT.clone();
      if (at.endsWith('/task/execution')) {
        const body: unknown = JSON.parse(String(init?.body ?? '{}'));
        const cursor =
          typeof body === 'object' && body !== null && 'cursor' in body ? body.cursor : undefined;
        cursors.push(cursor);
        if (cursor === 200) {
          return json({
            ok: true,
            execution: {
              outcome: 'ready',
              taskId: TASK.id,
              sourceRevision: 201,
              complete: true,
              next: null,
              runs: [run('r-1', 'done')],
              events: [event(201, 'r-1', 'handed_back')],
            },
          });
        }
        return json({
          ok: true,
          execution: {
            outcome: 'ready',
            taskId: TASK.id,
            sourceRevision: 201,
            complete: false,
            next: 200,
            runs: [run('r-1', 'running')],
            events: Array.from({ length: 200 }, (_, index) => event(index + 1, 'r-1', 'claimed')),
          },
        });
      }
      return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
    }) as typeof globalThis.fetch;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      token: 'a-token',
      fetch,
      newOperationId: () => 'operation-1',
    });
    const page = await mount(
      <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-31" />,
    );
    await tick();
    try {
      expect(cursors).toContain(200);
      expect(page.find('[data-run-id="r-1"] [data-event-kind="handed_back"]')).not.toBeNull();
    } finally {
      await page.unmount();
    }
  });
});
