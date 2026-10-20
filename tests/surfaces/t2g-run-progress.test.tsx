// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// T2g, the run on the task page (product issue 15). The run's progress comes
// from `task.execution`, and its six read outcomes (loading, no run, denied,
// unavailable, stale, ready) each draw differently: an empty list never
// answers a denied, failed or unavailable read. Each run is drawn on its own,
// never merged, and a state the projection does not know prints raw at the
// waiting tone.

import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { runStories } from '../../packages/ui/src/index.ts';
import { lineage, running } from './mp-6-1-agent-fixtures.tsx';
import { mount } from './mount.tsx';
import {
  answer,
  drawn,
  event,
  json,
  open,
  RECEIPT,
  run,
  TASK,
  tick,
} from './t2g-run-progress-fixture.tsx';

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
    // The run's node names its currency, which counts the receipt's money.
    const node = {
      nodeId: 'r-1',
      condition: 'in_progress',
      planned: null,
      observed: {
        condition: 'in_progress',
        runState: 'running',
        attemptId: 'a-1',
        whoseMove: null,
        outcome: null,
        fault: null,
        lease: null,
        effectObserved: true,
        heldMinor: 2000,
        spentMinor: 1500,
        currency: 'AUD',
      },
    };
    const graph = { plan: 'unbound', sourceRevision: 1, complete: true, nodes: [node] };
    const page = await open(
      answer('ready', [run('r-1', 'running')], [event(1, 'r-1', 'claimed')], graph),
    );
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
      signedIn: true,
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

  it('a step priced and settled while the worker still holds its lease is still running', () => {
    // `task.observe` settles a completed step's spend `actual` and leaves the
    // lease live (core-runtime budget.ts), so the money alone is no hand-back.
    const attempt = { state: 'settled', outcome: 'completed' };
    const story = runStories([
      lineage({ reservations: [{ ...running, state: 'actual', attempt }] }),
    ]);
    expect([story[0]?.state, story[0]?.cancellable]).toStrictEqual(['running', true]);
  });
});
