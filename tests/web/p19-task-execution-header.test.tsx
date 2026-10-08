// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { lineage } from '../surfaces/mp-6-1-agent-fixtures.tsx';
import { NOT_FOUND, task, TASK_ID, tick } from './task-page-stub.tsx';

const answer = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const lineOf = (view: Mounted): HTMLElement | null =>
  view.host.querySelector<HTMLElement>('.tpr [data-run]');

const execution = (state?: string, over: Readonly<Record<string, unknown>> = {}) => ({
  ok: true,
  execution: {
    taskId: TASK_ID,
    outcome: state === undefined ? 'no-run' : 'ready',
    sourceRevision: 0,
    complete: true,
    next: null,
    events: [],
    runs:
      state === undefined
        ? []
        : [
            {
              runId: 'engine-only',
              lineageId: 'lineage',
              versionId: 'version',
              state,
              taskRevisionAtRequest: 4,
              createdAt: '',
            },
          ],
    ...over,
  },
});

async function scene(
  pages: readonly unknown[],
  over: Readonly<Record<string, unknown>> = {},
  reply?: (index: number) => Promise<Response>,
) {
  const calls: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const at = String(url);
    if (at.endsWith('/person/list')) return answer({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return answer({ ok: true, task: task(over) });
    if (at.endsWith('/task/execution')) {
      calls.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      if (reply !== undefined) return await reply(calls.length - 1);
      const body = pages[Math.min(calls.length - 1, pages.length - 1)];
      if (body instanceof Error) throw body;
      return answer(body);
    }
    throw new Error(`unrouted ${at}`);
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const view = await mount(
    <TaskDetailScreen client={client} grantKey="alpha:member" taskKey="Proj-Verity-Pacing" />,
  );
  await tick();
  return { view, calls, client };
}

describe('P19 the root task header uses the admitted execution read', () => {
  it.each(['planned', 'claimed', 'handed_back'])('shows an engine-only %s run', async (state) => {
    const { view, calls } = await scene([execution(state)]);
    const line = lineOf(view);
    expect(line?.dataset['run']).toBe(
      state === 'handed_back' ? 'finished' : state === 'planned' ? 'queued' : 'running',
    );
    expect(line?.textContent).not.toContain('No agent has run');
    expect(calls).toHaveLength(1);
    await view.unmount();
  });

  it.each([
    [NOT_FOUND],
    [new Error('offline')],
    [execution(undefined, { complete: false, next: null })],
    [execution(undefined, { taskId: 'different-task' })],
    [{ ok: true, execution: null }],
    [execution(undefined, { outcome: 'stale' })],
  ])('does not claim no run for an unreadable or incomplete answer %j', async (body) => {
    const { view } = await scene([body]);
    expect(lineOf(view)?.dataset['run']).toBe('unknown');
    expect(view.find('.tpr')?.textContent).not.toContain('No agent has run');
    await view.unmount();
  });

  it('an incomplete execution with no forward cursor is unavailable in every shared view', async () => {
    const { view } = await scene([execution(undefined, { complete: false, next: null })]);
    expect(view.host.querySelector<HTMLElement>('[data-run-progress]')?.dataset['outcome']).toBe(
      'unavailable',
    );
    expect(lineOf(view)?.dataset['run']).toBe('unknown');
    await view.unmount();
  });
});

describe('P19 shared execution pagination and activity', () => {
  it('walks the complete canonical read once for the header and Agent pane', async () => {
    const { view, calls } = await scene([
      execution(undefined, { complete: false, next: 1, sourceRevision: 1 }),
      execution('claimed', { sourceRevision: 1 }),
    ]);
    expect(calls).toStrictEqual([
      { recordId: 'Proj-Verity-Pacing' },
      { recordId: 'Proj-Verity-Pacing', cursor: 1 },
    ]);
    expect(lineOf(view)?.dataset['run']).toBe('running');
    await view.unmount();
  });
});

describe('P19 shared Agent activity', () => {
  it('keeps the Agent activity and run pane on the same admitted answer', async () => {
    const event = {
      eventId: 'e1',
      runId: 'engine-only',
      position: 1,
      kind: 'claimed',
      attemptId: 'a1',
      at: '2026-10-09T01:00:00.000Z',
      placement: { planRecordId: 'plan', stepKey: 'draft', planRun: false },
    };
    const { view, calls } = await scene(
      [
        execution('claimed', {
          sourceRevision: 1,
          events: [event],
          plans: [{ planRecordId: 'plan', steps: [{ key: 'draft', title: 'Draft the reply' }] }],
        }),
      ],
      { proposals: [lineage()] },
    );
    expect(view.find('[data-agent="log"] [data-log="title"]')?.textContent).toBe('Draft the reply');
    expect(view.find('[data-run-progress] [data-run-id="engine-only"]')).not.toBeNull();
    expect(view.all('[data-section="agent"]')).toHaveLength(1);
    expect(calls).toHaveLength(1);
    await view.unmount();
  });

  it('does not use the first execution page after a later refusal', async () => {
    const { view, calls } = await scene([
      execution('claimed', { complete: false, next: 1 }),
      NOT_FOUND,
    ]);
    expect(calls).toHaveLength(2);
    expect(lineOf(view)?.dataset['run']).toBe('unknown');
    await view.unmount();
  });
});

describe('P19 unknown execution and owner boundaries', () => {
  it.each(['waiting_budget', 'a-new-state'])(
    'keeps %s distinct from a finished run',
    async (state) => {
      const { view } = await scene([execution(state)]);
      const line = lineOf(view);
      expect(line?.dataset['run']).toBe(state === 'waiting_budget' ? 'waiting' : 'unknown');
      expect(line?.textContent).toContain(state === 'waiting_budget' ? 'budget' : state);
      await view.unmount();
    },
  );

  it('does not restore an old owner’s held execution after the next owner is refused', async () => {
    let release: ((response: Response) => void) | undefined;
    const { view, client } = await scene([], {}, async (index) =>
      index === 0
        ? await new Promise<Response>((resolve) => {
            release = resolve;
          })
        : answer(NOT_FOUND),
    );
    expect(lineOf(view)?.textContent).toContain('Reading');
    await view.render(
      <TaskDetailScreen client={client} grantKey="alpha:revoked" taskKey="Proj-Verity-Pacing" />,
    );
    await tick();
    expect(lineOf(view)?.textContent).toContain('withheld');
    await act(async () => {
      await Promise.resolve(release?.(answer(execution('claimed'))));
    });
    await tick();
    expect(lineOf(view)?.textContent).toContain('withheld');
    expect(lineOf(view)?.textContent).not.toContain('running');
    await view.unmount();
  });

  it('requires carried proposals as well as a complete engine no-run answer', async () => {
    const { view } = await scene([execution()], { proposals: undefined });
    expect(lineOf(view)?.dataset['run']).toBe('unknown');
    await view.unmount();
  });
});
